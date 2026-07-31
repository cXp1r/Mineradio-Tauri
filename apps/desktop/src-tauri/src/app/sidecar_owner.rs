use std::{
    path::PathBuf,
    process::Child,
    time::{Duration, Instant},
};

use crate::{sidecar, AppState};

use super::update_install_gate::UpdateInstallGateClaim;

// 每次实际 child spawn 都在同一锁域冻结描述符；exact rollback 由 #54 cutover 才启用。
#[allow(dead_code)]
#[derive(Clone, Debug)]
pub(crate) struct SidecarLaunchDescriptor {
    plan: sidecar::SidecarLaunchPlan,
    port: u16,
    app_data_dir: PathBuf,
    log_dir: PathBuf,
    app_version: String,
}

#[allow(dead_code)]
impl SidecarLaunchDescriptor {
    pub(crate) fn command_and_descriptor(
        plan: sidecar::SidecarLaunchPlan,
        port: u16,
        app_data_dir: PathBuf,
        log_dir: PathBuf,
        app_version: String,
    ) -> (std::process::Command, Self) {
        let descriptor = Self {
            plan,
            port,
            app_data_dir,
            log_dir,
            app_version,
        };
        let command = descriptor.command();
        (command, descriptor)
    }

    fn command(&self) -> std::process::Command {
        sidecar::build_sidecar_command_from_plan(
            &self.plan,
            self.port,
            &self.app_data_dir,
            &self.log_dir,
            &self.app_version,
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SidecarInstallHolder(UpdateInstallGateClaim);

#[allow(dead_code)]
impl SidecarInstallHolder {
    fn from_claim(claim: &UpdateInstallGateClaim) -> Self {
        Self(claim.clone())
    }

    fn matches(&self, claim: &UpdateInstallGateClaim) -> bool {
        &self.0 == claim
    }
}

#[derive(Default)]
pub(crate) struct SidecarUpdateOwnerState {
    holder: Option<SidecarInstallHolder>,
}

#[allow(dead_code)]
impl SidecarUpdateOwnerState {
    pub(crate) fn supervisor_blocked(&self) -> bool {
        self.holder.is_some()
    }

    fn claim(&mut self, claim: &UpdateInstallGateClaim) -> Result<(), String> {
        let requested = SidecarInstallHolder::from_claim(claim);
        match self.holder.as_ref() {
            None => {
                self.holder = Some(requested);
                Ok(())
            }
            Some(current) if current == &requested => Ok(()),
            Some(_) => Err("SIDECAR_UPDATE_OWNER_BUSY".to_owned()),
        }
    }

    fn release(&mut self, claim: &UpdateInstallGateClaim) -> Result<(), String> {
        if !self
            .holder
            .as_ref()
            .is_some_and(|holder| holder.matches(claim))
        {
            return Err("SIDECAR_UPDATE_OWNER_STALE".to_owned());
        }
        self.holder = None;
        Ok(())
    }

    fn held_by(&self, claim: &UpdateInstallGateClaim) -> bool {
        self.holder
            .as_ref()
            .is_some_and(|holder| holder.matches(claim))
    }
}

#[derive(Clone)]
#[allow(dead_code)]
struct SidecarRuntimeRestore {
    phase: sidecar::SidecarPhase,
    restarts: u32,
    last_error: Option<String>,
    last_health_ok_ms: Option<u64>,
    providers: Vec<String>,
}

#[allow(dead_code)]
pub(crate) struct SidecarInstallReceipt {
    claim: UpdateInstallGateClaim,
    prior: SidecarRuntimeRestore,
    had_child: bool,
    child: Option<Child>,
}

#[allow(dead_code)]
impl SidecarInstallReceipt {
    pub(crate) fn terminate_bounded(&mut self, timeout: Duration) -> Result<bool, String> {
        let Some(child) = self.child.as_mut() else {
            return Ok(true);
        };
        if child
            .try_wait()
            .map_err(|_| "SIDECAR_UPDATE_CHILD_WAIT_FAILED".to_owned())?
            .is_none()
        {
            child
                .kill()
                .map_err(|_| "SIDECAR_UPDATE_CHILD_KILL_FAILED".to_owned())?;
        }
        let deadline = Instant::now() + timeout;
        loop {
            if child
                .try_wait()
                .map_err(|_| "SIDECAR_UPDATE_CHILD_WAIT_FAILED".to_owned())?
                .is_some()
            {
                self.child = None;
                return Ok(true);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(false);
            }
            std::thread::sleep(remaining.min(Duration::from_millis(10)));
        }
    }

    pub(crate) fn rollback(
        &mut self,
        state: &AppState,
        health_timeout: Duration,
    ) -> Result<(), String> {
        if self.child.is_some() {
            return Err("SIDECAR_UPDATE_CHILD_STOP_INCOMPLETE".to_owned());
        }
        assert_exact_holder(state, &self.claim)?;
        if self.had_child {
            let descriptor = state
                .sidecar_launch_descriptor
                .lock()
                .map_err(|_| "SIDECAR_LAUNCH_DESCRIPTOR_UNAVAILABLE".to_owned())?
                .clone()
                .ok_or_else(|| "SIDECAR_LAUNCH_DESCRIPTOR_MISSING".to_owned())?;
            let mut runtime = state
                .sidecar
                .lock()
                .map_err(|_| "SIDECAR_RUNTIME_UNAVAILABLE".to_owned())?;
            let child_exited = sidecar::sidecar_runtime_child_exited(&mut runtime)
                .map_err(|_| "SIDECAR_UPDATE_ROLLBACK_CHILD_STATUS_FAILED".to_owned())?;
            if runtime.child.is_none() || child_exited {
                sidecar::spawn_sidecar_into_runtime(
                    &mut runtime,
                    descriptor.command(),
                    health_timeout,
                )
                .map_err(|_| "SIDECAR_UPDATE_ROLLBACK_START_FAILED".to_owned())?;
            } else {
                let health = sidecar::wait_for_health(&runtime.base_url, health_timeout)
                    .map_err(|_| "SIDECAR_UPDATE_ROLLBACK_HEALTH_FAILED".to_owned())?;
                sidecar::sidecar_runtime_mark_ready(&mut runtime, health, sidecar::now_ms());
            }
        } else {
            let mut runtime = state
                .sidecar
                .lock()
                .map_err(|_| "SIDECAR_RUNTIME_UNAVAILABLE".to_owned())?;
            if runtime.child.is_some() {
                return Err("SIDECAR_UPDATE_UNEXPECTED_CHILD".to_owned());
            }
            runtime.phase = self.prior.phase.clone();
            runtime.restarts = self.prior.restarts;
            runtime.last_error = self.prior.last_error.clone();
            runtime.last_health_ok_ms = self.prior.last_health_ok_ms;
            runtime.providers = self.prior.providers.clone();
        }
        state
            .sidecar_update_owner
            .lock()
            .map_err(|_| "SIDECAR_UPDATE_OWNER_UNAVAILABLE".to_owned())?
            .release(&self.claim)
    }
}

/// ownership 锁序固定为 sidecar_update_owner → launch_descriptor → sidecar；
/// take 不读 descriptor，因而仅取 owner → sidecar。claim 发布后不会再出现越过 gate 的新 child。
#[allow(dead_code)]
pub(crate) fn take_for_update(
    state: &AppState,
    claim: &UpdateInstallGateClaim,
) -> Result<SidecarInstallReceipt, String> {
    let mut owner = state
        .sidecar_update_owner
        .lock()
        .map_err(|_| "SIDECAR_UPDATE_OWNER_UNAVAILABLE".to_owned())?;
    owner.claim(claim)?;
    let mut runtime = match state.sidecar.lock() {
        Ok(runtime) => runtime,
        Err(_) => {
            let _ = owner.release(claim);
            return Err("SIDECAR_RUNTIME_UNAVAILABLE".to_owned());
        }
    };
    let prior = SidecarRuntimeRestore {
        phase: runtime.phase.clone(),
        restarts: runtime.restarts,
        last_error: runtime.last_error.clone(),
        last_health_ok_ms: runtime.last_health_ok_ms,
        providers: runtime.providers.clone(),
    };
    let child = sidecar::sidecar_runtime_mark_stopped(&mut runtime);
    let had_child = child.is_some();
    Ok(SidecarInstallReceipt {
        claim: claim.clone(),
        prior,
        had_child,
        child,
    })
}

#[allow(dead_code)]
pub(crate) fn assert_exact_holder(
    state: &AppState,
    claim: &UpdateInstallGateClaim,
) -> Result<(), String> {
    if state
        .sidecar_update_owner
        .lock()
        .map_err(|_| "SIDECAR_UPDATE_OWNER_UNAVAILABLE".to_owned())?
        .held_by(claim)
    {
        Ok(())
    } else {
        Err("SIDECAR_UPDATE_OWNER_STALE".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::update_install_gate::UpdateInstallGate;
    use std::{ffi::OsString, path::Path, process::Command};

    fn command_shape(
        command: &Command,
    ) -> (
        OsString,
        Vec<OsString>,
        Option<PathBuf>,
        Vec<(OsString, Option<OsString>)>,
    ) {
        (
            command.get_program().to_os_string(),
            command.get_args().map(OsString::from).collect(),
            command.get_current_dir().map(Path::to_path_buf),
            command
                .get_envs()
                .map(|(key, value)| (key.to_os_string(), value.map(OsString::from)))
                .collect(),
        )
    }

    #[test]
    fn launch_command_and_rollback_descriptor_share_one_resolved_plan() {
        let plan = sidecar::SidecarLaunchPlan::bundled(PathBuf::from("exact-sidecar.exe"));
        let (command, descriptor) = SidecarLaunchDescriptor::command_and_descriptor(
            plan,
            32123,
            PathBuf::from("app-data"),
            PathBuf::from("logs"),
            "1.0.0".to_owned(),
        );

        assert_eq!(
            command_shape(&command),
            command_shape(&descriptor.command())
        );
    }

    #[test]
    fn sidecar_update_owner_is_exact_and_blocks_supervisor_until_release() {
        let gate = UpdateInstallGate::default();
        let first = gate
            .claim("sidecar-first", Duration::ZERO)
            .expect("first claim");
        gate.reopen_after_verified_rollback(&first)
            .expect("first gate rollback");
        let second = gate
            .claim("sidecar-second", Duration::ZERO)
            .expect("second claim");
        let mut owner = SidecarUpdateOwnerState::default();

        owner.claim(&second).expect("exact owner claim");
        assert!(owner.supervisor_blocked());
        assert_eq!(
            owner.release(&first),
            Err("SIDECAR_UPDATE_OWNER_STALE".to_owned())
        );
        assert!(owner.supervisor_blocked());
        owner.release(&second).expect("exact owner release");
        assert!(!owner.supervisor_blocked());
    }
}
