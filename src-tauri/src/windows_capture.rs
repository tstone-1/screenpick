// HDR-capable WGC capture. xcap remains the SDR path and window enumerator.
// Never fall back to 8-bit after an HDR capture error: it silently reintroduces
// clipping. Display state is queried per capture, not cached across HDR toggles
// or moves between monitors.
use std::{sync::mpsc::sync_channel, time::Duration};

use scopeguard::guard;
use windows::{
    core::{factory, IInspectable, Interface},
    Foundation::TypedEventHandler,
    Graphics::{
        Capture::{Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem},
        DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat},
    },
    Win32::{
        Devices::Display::{
            DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes, QueryDisplayConfig,
            DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO,
            DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL,
            DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, DISPLAYCONFIG_DEVICE_INFO_HEADER,
            DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO, DISPLAYCONFIG_MODE_INFO,
            DISPLAYCONFIG_PATH_INFO, DISPLAYCONFIG_SDR_WHITE_LEVEL,
            DISPLAYCONFIG_SOURCE_DEVICE_NAME, QDC_ONLY_ACTIVE_PATHS,
        },
        Foundation::{ERROR_INSUFFICIENT_BUFFER, HWND, POINT},
        Graphics::{
            Direct3D::D3D_DRIVER_TYPE_HARDWARE,
            Direct3D11::{
                D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
                D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE,
                D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
            },
            Dxgi::{Common::DXGI_FORMAT_R16G16B16A16_FLOAT, IDXGIDevice},
            Gdi::{
                GetMonitorInfoW, MonitorFromPoint, HMONITOR, MONITORINFOEXW,
                MONITOR_DEFAULTTONEAREST,
            },
        },
        System::WinRT::{
            Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess},
            Graphics::Capture::IGraphicsCaptureItemInterop,
        },
    },
};
use xcap::{image::RgbaImage, Monitor, Window};

fn error(e: impl std::fmt::Display) -> String {
    format!("Windows HDR capture: {e}")
}

fn monitor_handle(monitor: &Monitor) -> Result<HMONITOR, String> {
    let x = monitor.x().map_err(error)? + (monitor.width().map_err(error)? / 2) as i32;
    let y = monitor.y().map_err(error)? + (monitor.height().map_err(error)? / 2) as i32;
    Ok(unsafe { MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST) })
}

// None means SDR; Some(scale) means float capture is required. Query failures
// are errors, not evidence that HDR is disabled.
pub(crate) fn white_scale(monitor: &Monitor) -> Result<Option<f32>, String> {
    let handle = monitor_handle(monitor)?;
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    if !unsafe { GetMonitorInfoW(handle, &mut info.monitorInfo).as_bool() } {
        return Err(error("cannot identify capture display"));
    }
    // The topology can change between sizing and reading its buffers.
    for _ in 0..3 {
        let mut path_count = 0;
        let mut mode_count = 0;
        unsafe {
            GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut path_count, &mut mode_count)
        }
        .ok()
        .map_err(error)?;
        let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); path_count as usize];
        let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); mode_count as usize];
        let status = unsafe {
            QueryDisplayConfig(
                QDC_ONLY_ACTIVE_PATHS,
                &mut path_count,
                paths.as_mut_ptr(),
                &mut mode_count,
                modes.as_mut_ptr(),
                None,
            )
        };
        if status == ERROR_INSUFFICIENT_BUFFER {
            continue;
        }
        status.ok().map_err(error)?;
        for path in paths.iter().take(path_count as usize) {
            let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME {
                header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                    r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                    size: std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32,
                    adapterId: path.sourceInfo.adapterId,
                    id: path.sourceInfo.id,
                },
                ..Default::default()
            };
            let status = unsafe { DisplayConfigGetDeviceInfo(&mut source.header) };
            if status != 0 {
                return Err(error(format!("display source query failed ({status})")));
            }
            let name = |s: &[u16]| {
                s.iter()
                    .copied()
                    .take_while(|&c| c != 0)
                    .collect::<Vec<_>>()
            };
            if name(&source.viewGdiDeviceName) != name(&info.szDevice) {
                continue;
            }
            let mut color = DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO {
                header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                    r#type: DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO,
                    size: std::mem::size_of::<DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO>() as u32,
                    adapterId: path.targetInfo.adapterId,
                    id: path.targetInfo.id,
                },
                ..Default::default()
            };
            let status = unsafe { DisplayConfigGetDeviceInfo(&mut color.header) };
            if status != 0 {
                return Err(error(format!("advanced color query failed ({status})")));
            }
            if unsafe { color.Anonymous.value } & 2 == 0 {
                return Ok(None);
            }
            let mut white = DISPLAYCONFIG_SDR_WHITE_LEVEL {
                header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                    r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL,
                    size: std::mem::size_of::<DISPLAYCONFIG_SDR_WHITE_LEVEL>() as u32,
                    adapterId: path.targetInfo.adapterId,
                    id: path.targetInfo.id,
                },
                ..Default::default()
            };
            let status = unsafe { DisplayConfigGetDeviceInfo(&mut white.header) };
            if status != 0 || white.SDRWhiteLevel == 0 {
                return Err(error(format!("SDR white level query failed ({status})")));
            }
            return Ok(Some(white.SDRWhiteLevel as f32 / 1000.0));
        }
        return Err(error(
            "capture display is not in the active display topology",
        ));
    }
    Err(error("display topology kept changing; retry capture"))
}

pub(crate) fn window_image(window: &Window) -> Result<Option<RgbaImage>, String> {
    let Some(scale) = white_scale(&window.current_monitor().map_err(error)?)? else {
        return Ok(None);
    };
    let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>().map_err(error)?;
    // xcap's Windows id is the HWND (its public API exposes handles as u32).
    let hwnd = HWND(window.id().map_err(error)? as usize as *mut _);
    let item = unsafe { interop.CreateForWindow(hwnd) }.map_err(error)?;
    capture_item(&item, scale).map(Some)
}

pub(crate) fn monitor_image(monitor: &Monitor) -> Result<Option<RgbaImage>, String> {
    let Some(scale) = white_scale(monitor)? else {
        return Ok(None);
    };
    let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>().map_err(error)?;
    let item = unsafe { interop.CreateForMonitor(monitor_handle(monitor)?) }.map_err(error)?;
    capture_item(&item, scale).map(Some)
}

fn capture_item(item: &GraphicsCaptureItem, scale: f32) -> Result<RgbaImage, String> {
    let table = crate::capture_color::srgb_table(scale)?;
    // Per-capture device/context: simultaneous captures cannot race on a shared
    // D3D immediate context, which is not thread safe.
    let mut device = None;
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            Default::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            None,
        )
    }
    .map_err(error)?;
    let device = device.ok_or_else(|| error("D3D device was not created"))?;
    let context = unsafe { device.GetImmediateContext() }.map_err(error)?;
    let dxgi: IDXGIDevice = device.cast().map_err(error)?;
    let runtime_device: IDirect3DDevice = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) }
        .and_then(|d| d.cast())
        .map_err(error)?;
    let size = item.Size().map_err(error)?;
    let pool = guard(
        Direct3D11CaptureFramePool::CreateFreeThreaded(
            &runtime_device,
            DirectXPixelFormat::R16G16B16A16Float,
            1,
            size,
        )
        .map_err(error)?,
        |p| {
            let _ = p.Close();
        },
    );
    let (tx, rx) = sync_channel(1);
    let claimed = std::sync::atomic::AtomicBool::new(false);
    let token = pool
        .FrameArrived(
            &TypedEventHandler::<Direct3D11CaptureFramePool, IInspectable>::new(move |pool, _| {
                if claimed.swap(true, std::sync::atomic::Ordering::Relaxed) {
                    return Ok(());
                }
                let result = (|| {
                    let frame = pool
                        .as_ref()
                        .ok_or_else(|| error("missing frame pool"))?
                        .TryGetNextFrame()
                        .map_err(error)?;
                    let frame = guard(frame, |f| {
                        let _ = f.Close();
                    });
                    read_frame(&device, &context, &frame, size.Width, size.Height, &table)
                })();
                // Send errors too; do not disguise a GPU/readback failure as timeout.
                let _ = tx.try_send(result);
                Ok(())
            }),
        )
        .map_err(error)?;
    let _handler = guard(token, |t| {
        let _ = pool.RemoveFrameArrived(t);
    });
    let session = guard(pool.CreateCaptureSession(item).map_err(error)?, |s| {
        let _ = s.Close();
    });
    let _ = session.SetIsBorderRequired(false);
    let _ = session.SetIsCursorCaptureEnabled(false);
    session.StartCapture().map_err(error)?;
    rx.recv_timeout(Duration::from_secs(3)).map_err(error)?
}

fn read_frame(
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
    frame: &Direct3D11CaptureFrame,
    width: i32,
    height: i32,
    table: &[u8; 65536],
) -> Result<RgbaImage, String> {
    let content = frame.ContentSize().map_err(error)?;
    if width <= 0 || height <= 0 || content.Width != width || content.Height != height {
        return Err(error("capture target resized; retry capture"));
    }
    let access: IDirect3DDxgiInterfaceAccess =
        frame.Surface().and_then(|s| s.cast()).map_err(error)?;
    let source: ID3D11Texture2D = unsafe { access.GetInterface() }.map_err(error)?;
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { source.GetDesc(&mut desc) };
    if desc.Format != DXGI_FORMAT_R16G16B16A16_FLOAT
        || desc.Width < width as u32
        || desc.Height < height as u32
    {
        return Err(error("unexpected HDR capture texture"));
    }
    desc.BindFlags = 0;
    desc.MiscFlags = 0;
    desc.Usage = D3D11_USAGE_STAGING;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
    let mut staging = None;
    unsafe { device.CreateTexture2D(&desc, None, Some(&mut staging)) }.map_err(error)?;
    let staging = staging.ok_or_else(|| error("staging texture was not created"))?;
    unsafe { context.CopyResource(&staging, &source) };
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    unsafe { context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) }.map_err(error)?;
    let _mapping = guard((), |_| unsafe { context.Unmap(&staging, 0) });
    if mapped.pData.is_null() || (mapped.RowPitch as usize) < width as usize * 8 {
        return Err(error("invalid mapped HDR texture"));
    }
    let mut image = RgbaImage::new(width as u32, height as u32);
    for (y, row) in image.rows_mut().enumerate() {
        // Respect D3D's row padding; only ContentSize pixels are valid.
        let input = unsafe {
            std::slice::from_raw_parts(
                (mapped.pData as *const u8).add(y * mapped.RowPitch as usize) as *const u16,
                width as usize * 4,
            )
        };
        for (pixel, rgba) in row.zip(input.as_chunks::<4>().0) {
            pixel.0 = [
                table[rgba[0] as usize],
                table[rgba[1] as usize],
                table[rgba[2] as usize],
                (half::f16::from_bits(rgba[3]).to_f32().clamp(0.0, 1.0) * 255.0).round() as u8,
            ];
        }
    }
    Ok(image)
}
