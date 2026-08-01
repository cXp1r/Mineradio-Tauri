//! 可选 Windows Graphics Capture 底栏采样 owner。
//!
//! M7 的主背景 transport 是 DWM thumbnail。当前构建没有引入 WinRT/D3D capture
//! 依赖，因此本 owner 明确报告 unsupported，绝不把尚未创建的 frame pool 伪装成
//! ready，也不会阻塞 DWM Scene 激活。后续实现只需替换本 owner 内部 backend。

use super::error::WindowsWallpaperResult;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WgcSamplerStatus {
    pub supported: bool,
    pub ready: bool,
    pub stopped: bool,
    pub surface_window_handle: u64,
}

/// WGC 资源的单一 owner seam。即使平台不支持，stop/drop 仍保持幂等。
#[derive(Debug)]
pub struct WgcSamplerOwner {
    status: WgcSamplerStatus,
}

impl WgcSamplerOwner {
    pub fn start_for_surface(surface_window_handle: u64) -> Self {
        Self {
            status: WgcSamplerStatus {
                supported: false,
                ready: false,
                stopped: false,
                surface_window_handle,
            },
        }
    }

    pub fn status(&self) -> WgcSamplerStatus {
        self.status
    }

    pub fn stop(&mut self) -> WindowsWallpaperResult<()> {
        self.status.ready = false;
        self.status.stopped = true;
        Ok(())
    }
}

impl Drop for WgcSamplerOwner {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::WgcSamplerOwner;

    #[test]
    fn unavailable_wgc_never_reports_fake_ready_and_stops_idempotently() {
        let mut owner = WgcSamplerOwner::start_for_surface(42);
        assert!(!owner.status().supported);
        assert!(!owner.status().ready);

        owner.stop().expect("第一次 stop 应成功");
        owner.stop().expect("重复 stop 应幂等");
        assert!(owner.status().stopped);
        assert!(!owner.status().ready);
    }
}
