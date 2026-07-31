use std::{
    fmt,
    sync::{Arc, Condvar, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdateInstallGateClaim {
    operation_id: String,
    generation: u64,
}

impl UpdateInstallGateClaim {
    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdateInstallGateSnapshot {
    pub generation: u64,
    pub holder: Option<UpdateInstallGateClaim>,
    pub in_flight: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UpdateInstallGateError {
    InvalidOperation,
    MutationFrozen(UpdateInstallGateClaim),
    ClaimActive(UpdateInstallGateClaim),
    DrainTimedOut(UpdateInstallGateClaim),
    StaleClaim,
    InFlightAfterClaim,
}

impl UpdateInstallGateError {
    pub(crate) fn stable_code(&self) -> &'static str {
        match self {
            Self::InvalidOperation => "UPDATE_INSTALL_OPERATION_INVALID",
            Self::MutationFrozen(_) => "UPDATE_INSTALL_MUTATION_FROZEN",
            Self::ClaimActive(_) => "UPDATE_INSTALL_CLAIM_ACTIVE",
            Self::DrainTimedOut(_) => "UPDATE_INSTALL_DRAIN_TIMEOUT",
            Self::StaleClaim => "UPDATE_INSTALL_CLAIM_STALE",
            Self::InFlightAfterClaim => "UPDATE_INSTALL_DRAIN_INCOMPLETE",
        }
    }
}

impl fmt::Display for UpdateInstallGateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.stable_code())
    }
}

impl std::error::Error for UpdateInstallGateError {}

#[derive(Default)]
struct GateState {
    generation: u64,
    holder: Option<UpdateInstallGateClaim>,
    in_flight: usize,
}

#[derive(Default)]
struct GateInner {
    state: Mutex<GateState>,
    drained: Condvar,
}

#[derive(Clone, Default)]
pub struct UpdateInstallGate {
    inner: Arc<GateInner>,
}

pub struct UpdateInstallMutationPermit {
    inner: Arc<GateInner>,
    generation: u64,
    released: bool,
}

impl UpdateInstallMutationPermit {
    pub fn generation(&self) -> u64 {
        self.generation
    }
}

impl Drop for UpdateInstallMutationPermit {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.in_flight = state.in_flight.saturating_sub(1);
        self.inner.drained.notify_all();
    }
}

impl UpdateInstallGate {
    pub fn enter_mutation(&self) -> Result<UpdateInstallMutationPermit, UpdateInstallGateError> {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(holder) = state.holder.clone() {
            return Err(UpdateInstallGateError::MutationFrozen(holder));
        }
        state.in_flight = state.in_flight.saturating_add(1);
        Ok(UpdateInstallMutationPermit {
            inner: Arc::clone(&self.inner),
            generation: state.generation,
            released: false,
        })
    }

    pub fn claim(
        &self,
        operation_id: &str,
        drain_timeout: Duration,
    ) -> Result<UpdateInstallGateClaim, UpdateInstallGateError> {
        if !valid_operation_id(operation_id) {
            return Err(UpdateInstallGateError::InvalidOperation);
        }
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(holder) = state.holder.clone() {
            return Err(UpdateInstallGateError::ClaimActive(holder));
        }
        state.generation = state.generation.wrapping_add(1).max(1);
        let claim = UpdateInstallGateClaim {
            operation_id: operation_id.to_owned(),
            generation: state.generation,
        };
        // 先发布 holder，后等待既有 permit drain。Condvar 等待会释放 gate mutex，
        // permit Drop 与只读 snapshot 都不会被 install claim 阻塞。
        state.holder = Some(claim.clone());
        let deadline = Instant::now() + drain_timeout;
        while state.in_flight > 0 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(UpdateInstallGateError::DrainTimedOut(claim));
            }
            let (next, wait) = self
                .inner
                .drained
                .wait_timeout(state, remaining)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state = next;
            if wait.timed_out() && state.in_flight > 0 {
                return Err(UpdateInstallGateError::DrainTimedOut(claim));
            }
            if state.holder.as_ref() != Some(&claim) {
                return Err(UpdateInstallGateError::StaleClaim);
            }
        }
        Ok(claim)
    }

    pub fn reopen_after_verified_rollback(
        &self,
        claim: &UpdateInstallGateClaim,
    ) -> Result<(), UpdateInstallGateError> {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.holder.as_ref() != Some(claim) {
            return Err(UpdateInstallGateError::StaleClaim);
        }
        if state.in_flight != 0 {
            return Err(UpdateInstallGateError::InFlightAfterClaim);
        }
        state.holder = None;
        self.inner.drained.notify_all();
        Ok(())
    }

    pub fn snapshot(&self) -> UpdateInstallGateSnapshot {
        let state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        UpdateInstallGateSnapshot {
            generation: state.generation,
            holder: state.holder.clone(),
            in_flight: state.in_flight,
        }
    }
}

fn valid_operation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.chars().any(|character| character.is_control())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, thread, time::Instant};

    #[test]
    fn claim_freezes_new_mutations_before_bounded_drain() {
        let gate = UpdateInstallGate::default();
        let permit = gate.enter_mutation().expect("初始 mutation 应进入");
        let worker_gate = gate.clone();
        let (claim_tx, claim_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            let claim = worker_gate.claim("install-op-1", Duration::from_secs(1));
            claim_tx.send(claim).expect("应返回 claim 结果");
        });

        let deadline = Instant::now() + Duration::from_secs(1);
        while gate.snapshot().holder.is_none() && Instant::now() < deadline {
            thread::yield_now();
        }
        let snapshot = gate.snapshot();
        assert_eq!(snapshot.in_flight, 1);
        assert_eq!(
            snapshot.holder.as_ref().map(|holder| holder.operation_id()),
            Some("install-op-1")
        );
        assert!(matches!(
            gate.enter_mutation(),
            Err(UpdateInstallGateError::MutationFrozen(_))
        ));

        drop(permit);
        let claim = claim_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("permit Drop 后 claim 应完成")
            .expect("drain 应成功");
        worker.join().expect("claim worker 应退出");
        assert_eq!(gate.snapshot().in_flight, 0);

        drop(claim.clone());
        assert!(matches!(
            gate.enter_mutation(),
            Err(UpdateInstallGateError::MutationFrozen(_))
        ));
        gate.reopen_after_verified_rollback(&claim)
            .expect("exact verified rollback 才能重开");
        assert!(gate.enter_mutation().is_ok());
    }

    #[test]
    fn stale_claim_cannot_reopen_a_new_install_generation() {
        let gate = UpdateInstallGate::default();
        let first = gate
            .claim("install-op-1", Duration::from_millis(50))
            .expect("首个 claim 应成功");
        gate.reopen_after_verified_rollback(&first)
            .expect("首个 exact rollback 应成功");
        let second = gate
            .claim("install-op-2", Duration::from_millis(50))
            .expect("第二个 claim 应成功");

        assert!(second.generation() > first.generation());
        assert_eq!(
            gate.reopen_after_verified_rollback(&first),
            Err(UpdateInstallGateError::StaleClaim)
        );
        assert_eq!(gate.snapshot().holder, Some(second.clone()));
        gate.reopen_after_verified_rollback(&second)
            .expect("只有当前 generation 可以重开");
    }

    #[test]
    fn drain_timeout_retains_exact_holder_until_drain_and_verified_rollback() {
        let gate = UpdateInstallGate::default();
        let permit = gate.enter_mutation().expect("初始 mutation 应进入");

        let timed_out_claim = match gate.claim("install-timeout", Duration::ZERO) {
            Err(UpdateInstallGateError::DrainTimedOut(claim)) => claim,
            other => panic!("应保留 exact timeout claim，实际为 {other:?}"),
        };
        let snapshot = gate.snapshot();
        assert_eq!(snapshot.generation, 1);
        assert_eq!(snapshot.holder, Some(timed_out_claim.clone()));
        assert_eq!(snapshot.in_flight, 1);
        assert!(matches!(
            gate.enter_mutation(),
            Err(UpdateInstallGateError::MutationFrozen(_))
        ));
        assert!(matches!(
            gate.claim("new-install", Duration::ZERO),
            Err(UpdateInstallGateError::ClaimActive(_))
        ));
        assert_eq!(
            gate.reopen_after_verified_rollback(&timed_out_claim),
            Err(UpdateInstallGateError::InFlightAfterClaim)
        );

        drop(permit);
        gate.reopen_after_verified_rollback(&timed_out_claim)
            .expect("drain 后 exact verified rollback 应重开 gate");
        assert!(gate.enter_mutation().is_ok());
    }
}
