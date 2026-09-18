#![no_std]
//! # Spora Parametric Climate Escrow
//!
//! A milestone escrow that finances biological farm inputs shipped from
//! Caranavi, Bolivia to a smallholder coffee cooperative in Nyeri, Kenya, with
//! an automated parametric circuit breaker governed by satellite precipitation
//! telemetry.
//!
//! ## Accounting invariants
//!
//! Let `A_total` be the cumulative USDC deposited (7-decimal stroops).
//!
//! * `A_input  = floor(A_total * 9000 / 10000)`
//! * `A_buffer = A_total - A_input`
//! * therefore `A_input + A_buffer == A_total` exactly, for every `A_total`.
//!
//! The *remainder* form is deliberate. Computing the buffer as
//! `floor(A_total * 1000 / 10000)` independently would strand up to one stroop
//! per deposit in an unaccounted residue. Deriving the second leg by
//! subtraction makes the split lossless by construction, which is asserted
//! exhaustively in `test::allocation_split_is_lossless_across_remainders`.
//!
//! The same remainder discipline governs the parametric split:
//! `coop = floor(pool * 6000 / 10000)`, `supplier = pool - coop`.
//!
//! ## Deviations from the original specification
//!
//! 1. `complete_milestone` takes an explicit `caller: Address`. The original
//!    design called `admin.has_auth()`, which is not part of the Soroban host
//!    interface -- `Address` exposes `require_auth`/`require_auth_for_args`
//!    only. Passing the caller and comparing it against the two authorised
//!    principals is the idiomatic, on-chain-verifiable equivalent.
//! 2. Terminal disbursements sweep the **entire** contract balance rather than
//!    `min(balance, total_deposited)`. Capping at `total_deposited` would
//!    strand accrued Pollar Earn yield in a contract that can never move it
//!    again.
//! 3. `sweep_residual` exists because a parametric trigger can fire while the
//!    10% buffer is still deployed in a Blend pool or DeFindex vault. The
//!    redemption lands *after* settlement, so without a post-terminal sweep
//!    that principal-plus-yield would be permanently unrecoverable.
//! 4. Oracle reports carry an observation timestamp and are rejected unless
//!    strictly newer than the last accepted reading, so replaying a captured
//!    signed payload cannot re-arm or re-fire the breaker.

use soroban_sdk::{contract, contractimpl, panic_with_error, token, Address, BytesN, Env, Symbol};

mod types;
pub use types::*;

#[cfg(test)]
mod test;

/// ~30 days of ledgers at the 5 s close target.
const INSTANCE_BUMP_AMOUNT: u32 = 518_400;
/// Re-bump whenever the remaining TTL drops below ~10 days.
const INSTANCE_LIFETIME_THRESHOLD: u32 = 172_800;

const BPS_DENOMINATOR: i128 = 10_000;
/// 90% of deposits buy biological inputs.
const INPUT_ALLOCATION_BPS: i128 = 9_000;
/// On a parametric breach, 60% becomes emergency farmer relief.
const RELIEF_COOPERATIVE_BPS: i128 = 6_000;
/// Consecutive days below 1.0 mm required to arm the breach condition.
pub const DRY_DAY_TRIGGER: u32 = 21;

#[contract]
pub struct SporaEscrowContract;

#[contractimpl]
impl SporaEscrowContract {
    /// Wire the escrow's five principals and arm the parametric threshold.
    ///
    /// `threshold_mm` is the 21-day cumulative rainfall floor in whole
    /// millimetres. Zero is rejected: `rainfall < 0` is unsatisfiable over
    /// `u32`, so a zero threshold would silently disarm the circuit breaker
    /// while still presenting as a configured policy.
    #[allow(clippy::too_many_arguments)]
    pub fn initialize(
        env: Env,
        admin: Address,
        oracle: Address,
        cooperative: Address,
        supplier: Address,
        usdc_token: Address,
        threshold_mm: u32,
        order_hash: BytesN<32>,
    ) -> Result<(), SporaError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(SporaError::AlreadyInitialized);
        }
        if threshold_mm == 0 {
            return Err(SporaError::InvalidThreshold);
        }
        admin.require_auth();

        let store = env.storage().instance();
        store.set(&DataKey::Admin, &admin);
        store.set(&DataKey::Oracle, &oracle);
        store.set(&DataKey::Cooperative, &cooperative);
        store.set(&DataKey::Supplier, &supplier);
        store.set(&DataKey::UsdcToken, &usdc_token);
        store.set(&DataKey::Status, &EscrowStatus::Initialized);
        store.set(&DataKey::ThresholdMm, &threshold_mm);
        store.set(&DataKey::OrderMetadataHash, &order_hash);
        store.set(&DataKey::TotalDeposited, &0i128);
        store.set(&DataKey::InputAllocation, &0i128);
        store.set(&DataKey::BufferAllocation, &0i128);
        store.set(&DataKey::TotalDisbursed, &0i128);
        store.set(&DataKey::CurrentRainfallMm, &0u32);
        store.set(&DataKey::ConsecutiveDryDays, &0u32);
        store.set(&DataKey::OracleReportCount, &0u32);
        store.set(&DataKey::LastOracleTimestamp, &0u64);

        store.extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        env.events().publish(
            (Symbol::new(&env, "initialized"), admin),
            (cooperative, supplier, usdc_token, threshold_mm),
        );
        Ok(())
    }

    /// Pull `amount` USDC stroops from the cooperative into escrow and
    /// re-derive the 90/10 allocation over the new cumulative total.
    ///
    /// Recomputing from `new_total` (rather than incrementing each leg
    /// independently) keeps the split exact no matter how many partial M-Pesa
    /// contributions are aggregated: rounding is applied once, to the running
    /// total, instead of once per contribution.
    pub fn deposit_funds(env: Env, amount: i128) -> Result<(), SporaError> {
        let cooperative: Address = Self::load_address(&env, DataKey::Cooperative)?;
        cooperative.require_auth();

        let status = Self::load_status(&env)?;
        if status != EscrowStatus::Initialized && status != EscrowStatus::Funded {
            return Err(SporaError::InvalidStatus);
        }
        if amount <= 0 {
            return Err(SporaError::NonPositiveAmount);
        }

        let usdc: Address = Self::load_address(&env, DataKey::UsdcToken)?;
        token::Client::new(&env, &usdc).transfer(
            &cooperative,
            &env.current_contract_address(),
            &amount,
        );

        let store = env.storage().instance();
        let current_total: i128 = store.get(&DataKey::TotalDeposited).unwrap_or(0);
        let new_total = current_total
            .checked_add(amount)
            .ok_or(SporaError::MathOverflow)?;

        let input_alloc = new_total
            .checked_mul(INPUT_ALLOCATION_BPS)
            .ok_or(SporaError::MathOverflow)?
            / BPS_DENOMINATOR;
        let buffer_alloc = new_total
            .checked_sub(input_alloc)
            .ok_or(SporaError::MathOverflow)?;

        store.set(&DataKey::TotalDeposited, &new_total);
        store.set(&DataKey::InputAllocation, &input_alloc);
        store.set(&DataKey::BufferAllocation, &buffer_alloc);
        store.set(&DataKey::Status, &EscrowStatus::Funded);
        store.extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        env.events().publish(
            (Symbol::new(&env, "deposit"), cooperative),
            (amount, new_total, input_alloc, buffer_alloc),
        );
        Ok(())
    }

    /// Admin marks the biological inputs as dispatched from Caranavi.
    pub fn set_in_transit(env: Env) -> Result<(), SporaError> {
        let admin: Address = Self::load_address(&env, DataKey::Admin)?;
        admin.require_auth();

        if Self::load_status(&env)? != EscrowStatus::Funded {
            return Err(SporaError::InvalidStatus);
        }

        let store = env.storage().instance();
        store.set(&DataKey::Status, &EscrowStatus::InTransit);
        store.extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        env.events().publish(
            (Symbol::new(&env, "status_change"), admin),
            EscrowStatus::InTransit,
        );
        Ok(())
    }

    /// Ingest a signed satellite precipitation reading and evaluate the
    /// parametric condition `P_rolling < threshold AND D_consecutive >= 21`.
    ///
    /// `observed_at` is the observation timestamp supplied by the off-chain
    /// oracle. Readings must be strictly newer than the last accepted one,
    /// which renders replay of a captured signed payload inert.
    ///
    /// Returns `Some(settlement)` when the breach fires, `None` for a routine
    /// telemetry update, so the caller learns the outcome without re-reading
    /// state.
    pub fn report_weather(
        env: Env,
        rainfall_mm: u32,
        consecutive_dry_days: u32,
        observed_at: u64,
    ) -> Result<Option<Settlement>, SporaError> {
        let oracle: Address = Self::load_address(&env, DataKey::Oracle)?;
        oracle.require_auth();

        let status = Self::load_status(&env)?;
        if status != EscrowStatus::InTransit && status != EscrowStatus::Funded {
            return Err(SporaError::InvalidStatus);
        }

        let store = env.storage().instance();
        let last_seen: u64 = store.get(&DataKey::LastOracleTimestamp).unwrap_or(0);
        if observed_at <= last_seen {
            return Err(SporaError::StaleOracleReport);
        }

        let threshold_mm: u32 = store.get(&DataKey::ThresholdMm).unwrap_or(0);
        let report_count: u32 = store
            .get::<_, u32>(&DataKey::OracleReportCount)
            .unwrap_or(0)
            .saturating_add(1);

        store.set(&DataKey::CurrentRainfallMm, &rainfall_mm);
        store.set(&DataKey::ConsecutiveDryDays, &consecutive_dry_days);
        store.set(&DataKey::LastOracleTimestamp, &observed_at);
        store.set(&DataKey::OracleReportCount, &report_count);
        store.extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        let breached = rainfall_mm < threshold_mm && consecutive_dry_days >= DRY_DAY_TRIGGER;
        if !breached {
            env.events().publish(
                (Symbol::new(&env, "weather_update"), oracle),
                (rainfall_mm, consecutive_dry_days, observed_at, threshold_mm),
            );
            return Ok(None);
        }

        // Circuit breaker fires: 60% emergency relief to the Kenyan farmers,
        // 40% partial indemnity to the Bolivian supplier for inputs already
        // manufactured and shipped.
        let settlement =
            Self::settle(&env, RELIEF_COOPERATIVE_BPS, EscrowStatus::ParametricTriggered)?;

        env.events().publish(
            (Symbol::new(&env, "parametric_trigger"), oracle),
            (
                rainfall_mm,
                consecutive_dry_days,
                observed_at,
                settlement.cooperative_amount,
                settlement.supplier_amount,
            ),
        );
        Ok(Some(settlement))
    }

    /// Confirm physical delivery in Nyeri and release the full balance --
    /// input allocation, climate buffer, and any accrued Earn yield -- to the
    /// Bolivian supplier.
    ///
    /// Authorised for either the admin or the cooperative. The caller is an
    /// explicit parameter because Soroban's `Address` exposes no `has_auth()`
    /// predicate; authorisation is proven by `require_auth` on the passed
    /// address and then matched against the two allowed principals.
    pub fn complete_milestone(env: Env, caller: Address) -> Result<Settlement, SporaError> {
        caller.require_auth();

        let admin: Address = Self::load_address(&env, DataKey::Admin)?;
        let cooperative: Address = Self::load_address(&env, DataKey::Cooperative)?;
        if caller != admin && caller != cooperative {
            return Err(SporaError::Unauthorized);
        }

        let status = Self::load_status(&env)?;
        if status != EscrowStatus::InTransit && status != EscrowStatus::Funded {
            return Err(SporaError::InvalidStatus);
        }

        // 0 bps to the cooperative => the remainder, i.e. 100%, to the supplier.
        let settlement = Self::settle(&env, 0, EscrowStatus::Completed)?;

        env.events().publish(
            (Symbol::new(&env, "completed"), caller),
            (settlement.supplier_amount, settlement.total),
        );
        Ok(settlement)
    }

    /// Admin unwinds the escrow before dispatch, returning everything to the
    /// cooperative. Only reachable while the goods have not yet shipped: once
    /// `InTransit` the supplier has incurred real cost, and the parametric or
    /// completion paths govern instead.
    pub fn refund(env: Env) -> Result<Settlement, SporaError> {
        let admin: Address = Self::load_address(&env, DataKey::Admin)?;
        admin.require_auth();

        let status = Self::load_status(&env)?;
        if status != EscrowStatus::Initialized && status != EscrowStatus::Funded {
            return Err(SporaError::InvalidStatus);
        }

        let settlement = Self::settle(&env, BPS_DENOMINATOR, EscrowStatus::Refunded)?;

        env.events().publish(
            (Symbol::new(&env, "refunded"), admin),
            (settlement.cooperative_amount, settlement.total),
        );
        Ok(settlement)
    }

    /// Distribute value that arrived *after* terminal settlement -- in
    /// practice a Pollar Earn redemption of the climate buffer that was still
    /// in flight when the circuit breaker fired.
    ///
    /// Reuses the split recorded by the settlement that closed the escrow, so
    /// late yield follows exactly the same economics as the principal.
    /// Deliberately unpermissioned: it is a pure sweep to fixed beneficiaries
    /// and exercises no discretion, so gating it would add no safety while
    /// risking permanently stranded funds if the admin key were lost.
    pub fn sweep_residual(env: Env) -> Result<Settlement, SporaError> {
        let status = Self::load_status(&env)?;
        if !status.is_terminal() {
            return Err(SporaError::InvalidStatus);
        }

        let coop_bps: i128 = env
            .storage()
            .instance()
            .get(&DataKey::SettlementCoopBps)
            .ok_or(SporaError::NotInitialized)?;

        let settlement = Self::disburse(&env, coop_bps)?;

        env.events().publish(
            (Symbol::new(&env, "residual_swept"),),
            (
                settlement.cooperative_amount,
                settlement.supplier_amount,
                settlement.total,
            ),
        );
        Ok(settlement)
    }

    // ---- read-only views -------------------------------------------------

    pub fn get_escrow(env: Env) -> EscrowView {
        let store = env.storage().instance();
        EscrowView {
            status: store
                .get(&DataKey::Status)
                .unwrap_or(EscrowStatus::Initialized),
            total_deposited: store.get(&DataKey::TotalDeposited).unwrap_or(0),
            input_allocation: store.get(&DataKey::InputAllocation).unwrap_or(0),
            buffer_allocation: store.get(&DataKey::BufferAllocation).unwrap_or(0),
            total_disbursed: store.get(&DataKey::TotalDisbursed).unwrap_or(0),
            threshold_mm: store.get(&DataKey::ThresholdMm).unwrap_or(0),
            current_rainfall_mm: store.get(&DataKey::CurrentRainfallMm).unwrap_or(0),
            consecutive_dry_days: store.get(&DataKey::ConsecutiveDryDays).unwrap_or(0),
            oracle_report_count: store.get(&DataKey::OracleReportCount).unwrap_or(0),
            last_oracle_timestamp: store.get(&DataKey::LastOracleTimestamp).unwrap_or(0),
            cooperative: Self::expect_address(&env, DataKey::Cooperative),
            supplier: Self::expect_address(&env, DataKey::Supplier),
            usdc_token: Self::expect_address(&env, DataKey::UsdcToken),
        }
    }

    /// Current USDC held by the contract. Diverges from `total_deposited`
    /// whenever the climate buffer is deployed into a yield venue.
    pub fn get_balance(env: Env) -> i128 {
        let usdc = Self::expect_address(&env, DataKey::UsdcToken);
        token::Client::new(&env, &usdc).balance(&env.current_contract_address())
    }

    pub fn get_order_hash(env: Env) -> Option<BytesN<32>> {
        env.storage().instance().get(&DataKey::OrderMetadataHash)
    }

    /// Pure predicate mirroring the on-chain breach rule, exposed so the
    /// dashboard's chaos slider and the contract can never disagree about
    /// where the red zone begins.
    pub fn would_trigger(env: Env, rainfall_mm: u32, consecutive_dry_days: u32) -> bool {
        let threshold: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ThresholdMm)
            .unwrap_or(0);
        rainfall_mm < threshold && consecutive_dry_days >= DRY_DAY_TRIGGER
    }

    // ---- internals -------------------------------------------------------

    /// Move the whole contract balance out under `coop_bps`, record the split
    /// for later residual sweeps, and advance to the `next` terminal status.
    fn settle(env: &Env, coop_bps: i128, next: EscrowStatus) -> Result<Settlement, SporaError> {
        let store = env.storage().instance();
        store.set(&DataKey::SettlementCoopBps, &coop_bps);
        let settlement = Self::disburse(env, coop_bps)?;
        store.set(&DataKey::Status, &next);
        store.extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(settlement)
    }

    /// The single place value leaves this contract.
    ///
    /// Splits the live balance as `coop = floor(pool * coop_bps / 10000)` and
    /// `supplier = pool - coop`, so the two legs always re-sum to `pool` with
    /// no stroop unaccounted for. Zero-value legs are skipped rather than
    /// transferred, keeping the event stream free of no-op payments.
    fn disburse(env: &Env, coop_bps: i128) -> Result<Settlement, SporaError> {
        let usdc = Self::load_address(env, DataKey::UsdcToken)?;
        let client = token::Client::new(env, &usdc);
        let pool = client.balance(&env.current_contract_address());

        if pool <= 0 {
            return Err(SporaError::NothingToDisburse);
        }

        let coop_amount = pool
            .checked_mul(coop_bps)
            .ok_or(SporaError::MathOverflow)?
            / BPS_DENOMINATOR;
        let supplier_amount = pool
            .checked_sub(coop_amount)
            .ok_or(SporaError::MathOverflow)?;

        if coop_amount > 0 {
            let cooperative = Self::load_address(env, DataKey::Cooperative)?;
            client.transfer(&env.current_contract_address(), &cooperative, &coop_amount);
        }
        if supplier_amount > 0 {
            let supplier = Self::load_address(env, DataKey::Supplier)?;
            client.transfer(&env.current_contract_address(), &supplier, &supplier_amount);
        }

        let store = env.storage().instance();
        let disbursed: i128 = store.get(&DataKey::TotalDisbursed).unwrap_or(0);
        store.set(
            &DataKey::TotalDisbursed,
            &disbursed.checked_add(pool).ok_or(SporaError::MathOverflow)?,
        );

        Ok(Settlement {
            cooperative_amount: coop_amount,
            supplier_amount,
            total: pool,
        })
    }

    fn load_status(env: &Env) -> Result<EscrowStatus, SporaError> {
        env.storage()
            .instance()
            .get(&DataKey::Status)
            .ok_or(SporaError::NotInitialized)
    }

    fn load_address(env: &Env, key: DataKey) -> Result<Address, SporaError> {
        env.storage()
            .instance()
            .get(&key)
            .ok_or(SporaError::NotInitialized)
    }

    /// View-path address read. A view cannot return `Result` without changing
    /// its generated client signature, so an uninitialised read traps with the
    /// same typed error the mutating paths return.
    fn expect_address(env: &Env, key: DataKey) -> Address {
        match env.storage().instance().get(&key) {
            Some(addr) => addr,
            None => panic_with_error!(env, SporaError::NotInitialized),
        }
    }
}
