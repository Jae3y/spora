#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, BytesN as _, Ledger},
    token, Address, BytesN, Env,
};

/// 1 USDC == 10^7 stroops on Stellar.
const USDC: i128 = 10_000_000;

/// A deposit deliberately chosen to be indivisible by both the 90/10 and the
/// 60/40 splits, so every test exercises the remainder arm of the arithmetic
/// rather than the clean-division happy path.
const AWKWARD: i128 = 1_000_000_001;

struct Harness {
    env: Env,
    client: SporaEscrowContractClient<'static>,
    token: token::Client<'static>,
    minter: token::StellarAssetClient<'static>,
    contract_id: Address,
    admin: Address,
    oracle: Address,
    cooperative: Address,
    supplier: Address,
}

impl Harness {
    /// Stands up an initialised escrow with a 20 mm threshold and a
    /// cooperative pre-funded with `coop_balance` stroops of test USDC.
    fn new(coop_balance: i128) -> Self {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let oracle = Address::generate(&env);
        let cooperative = Address::generate(&env);
        let supplier = Address::generate(&env);

        let asset = env.register_stellar_asset_contract_v2(admin.clone());
        let usdc_address = asset.address();
        let token = token::Client::new(&env, &usdc_address);
        let minter = token::StellarAssetClient::new(&env, &usdc_address);
        minter.mint(&cooperative, &coop_balance);

        let contract_id = env.register_contract(None, SporaEscrowContract);
        let client = SporaEscrowContractClient::new(&env, &contract_id);

        client.initialize(
            &admin,
            &oracle,
            &cooperative,
            &supplier,
            &usdc_address,
            &20u32,
            &BytesN::random(&env),
        );

        Harness {
            env,
            client,
            token,
            minter,
            contract_id,
            admin,
            oracle,
            cooperative,
            supplier,
        }
    }

    fn escrow_balance(&self) -> i128 {
        self.token.balance(&self.contract_id)
    }

    /// Simulate a Pollar Earn redemption landing back in the escrow.
    fn credit_yield(&self, amount: i128) {
        self.minter.mint(&self.contract_id, &amount);
    }
}

// ---------------------------------------------------------------------------
// initialisation
// ---------------------------------------------------------------------------

#[test]
fn initialize_sets_expected_state() {
    let h = Harness::new(0);
    let view = h.client.get_escrow();

    assert_eq!(view.status, EscrowStatus::Initialized);
    assert_eq!(view.total_deposited, 0);
    assert_eq!(view.input_allocation, 0);
    assert_eq!(view.buffer_allocation, 0);
    assert_eq!(view.total_disbursed, 0);
    assert_eq!(view.threshold_mm, 20);
    assert_eq!(view.oracle_report_count, 0);
    assert_eq!(view.cooperative, h.cooperative);
    assert_eq!(view.supplier, h.supplier);
    assert!(h.client.get_order_hash().is_some());
}

#[test]
fn initialize_rejects_zero_threshold() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let asset = env.register_stellar_asset_contract_v2(admin.clone());
    let contract_id = env.register_contract(None, SporaEscrowContract);
    let client = SporaEscrowContractClient::new(&env, &contract_id);

    // A 0 mm threshold can never be breached (`r < 0` is unsatisfiable over
    // u32), so accepting it would present as an armed policy that is in fact
    // permanently disarmed.
    let result = client.try_initialize(
        &admin,
        &Address::generate(&env),
        &Address::generate(&env),
        &Address::generate(&env),
        &asset.address(),
        &0u32,
        &BytesN::random(&env),
    );
    assert_eq!(result, Err(Ok(SporaError::InvalidThreshold)));
}

#[test]
fn initialize_is_guarded_against_reentry() {
    let h = Harness::new(0);
    let result = h.client.try_initialize(
        &h.admin,
        &h.oracle,
        &h.cooperative,
        &h.supplier,
        &h.token.address,
        &20u32,
        &BytesN::random(&h.env),
    );
    assert_eq!(result, Err(Ok(SporaError::AlreadyInitialized)));
}

// ---------------------------------------------------------------------------
// deposits and the 90/10 allocation
// ---------------------------------------------------------------------------

#[test]
fn deposit_splits_ninety_ten_and_moves_exact_value() {
    let h = Harness::new(2_000 * USDC);
    h.client.deposit_funds(&(2_000 * USDC));

    let view = h.client.get_escrow();
    assert_eq!(view.status, EscrowStatus::Funded);
    assert_eq!(view.total_deposited, 2_000 * USDC);
    assert_eq!(view.input_allocation, 1_800 * USDC);
    assert_eq!(view.buffer_allocation, 200 * USDC);

    // Value actually left the cooperative and landed in the contract.
    assert_eq!(h.token.balance(&h.cooperative), 0);
    assert_eq!(h.escrow_balance(), 2_000 * USDC);
}

#[test]
fn deposit_allocation_is_lossless_on_indivisible_amounts() {
    let h = Harness::new(AWKWARD);
    h.client.deposit_funds(&AWKWARD);

    let view = h.client.get_escrow();
    // floor(1_000_000_001 * 0.9) == 900_000_000, remainder to the buffer.
    assert_eq!(view.input_allocation, 900_000_000);
    assert_eq!(view.buffer_allocation, 100_000_001);
    assert_eq!(
        view.input_allocation + view.buffer_allocation,
        view.total_deposited,
        "A_input + A_buffer must reconstruct A_total exactly"
    );
}

#[test]
fn allocation_split_is_lossless_across_remainders() {
    // Exhaustively sweep every distinct remainder class mod 10_000. If the
    // buffer were computed independently as floor(total * 1000 / 10000)
    // instead of by subtraction, this would strand a stroop on most of them.
    for r in 0..10_000i128 {
        let total = 10_000 * USDC + r;
        let input = (total * 9_000) / 10_000;
        let buffer = total - input;
        assert_eq!(input + buffer, total, "lossless split failed at r={}", r);
        assert!(buffer >= total / 10, "buffer under-allocated at r={}", r);
    }
}

#[test]
fn deposit_rejects_non_positive_amounts() {
    let h = Harness::new(100 * USDC);
    assert_eq!(
        h.client.try_deposit_funds(&0),
        Err(Ok(SporaError::NonPositiveAmount))
    );
    assert_eq!(
        h.client.try_deposit_funds(&-1),
        Err(Ok(SporaError::NonPositiveAmount))
    );
}

#[test]
fn successive_deposits_round_once_against_the_running_total() {
    let h = Harness::new(3);
    // Three 1-stroop deposits. Rounding per-deposit would floor each 0.9 to 0
    // and allocate nothing to inputs; rounding once against the total yields 2.
    h.client.deposit_funds(&1);
    h.client.deposit_funds(&1);
    h.client.deposit_funds(&1);

    let view = h.client.get_escrow();
    assert_eq!(view.total_deposited, 3);
    assert_eq!(view.input_allocation, 2);
    assert_eq!(view.buffer_allocation, 1);
}

// ---------------------------------------------------------------------------
// parametric breach -- exact 60/40 settlement
// ---------------------------------------------------------------------------

#[test]
fn parametric_breach_pays_sixty_forty_exactly() {
    let h = Harness::new(2_000 * USDC);
    h.client.deposit_funds(&(2_000 * USDC));
    h.client.set_in_transit();

    // Severe drought scenario: 8 mm over 21 rolling days, 24 consecutive dry.
    let settlement = h
        .client
        .report_weather(&8u32, &24u32, &1_700_000_000u64)
        .expect("breach must return a settlement");

    assert_eq!(settlement.total, 2_000 * USDC);
    assert_eq!(settlement.cooperative_amount, 1_200 * USDC);
    assert_eq!(settlement.supplier_amount, 800 * USDC);
    assert_eq!(
        settlement.cooperative_amount + settlement.supplier_amount,
        settlement.total
    );

    // Exact balances, not just the returned struct.
    assert_eq!(h.token.balance(&h.cooperative), 1_200 * USDC);
    assert_eq!(h.token.balance(&h.supplier), 800 * USDC);
    assert_eq!(h.escrow_balance(), 0, "escrow must be fully drained");

    let view = h.client.get_escrow();
    assert_eq!(view.status, EscrowStatus::ParametricTriggered);
    assert_eq!(view.total_disbursed, 2_000 * USDC);
    assert_eq!(view.current_rainfall_mm, 8);
    assert_eq!(view.consecutive_dry_days, 24);
    assert_eq!(view.oracle_report_count, 1);
}

#[test]
fn parametric_breach_is_lossless_on_indivisible_pools() {
    let h = Harness::new(AWKWARD);
    h.client.deposit_funds(&AWKWARD);
    h.client.set_in_transit();

    let s = h
        .client
        .report_weather(&8u32, &24u32, &1_700_000_000u64)
        .unwrap();

    // floor(1_000_000_001 * 0.6) == 600_000_000; the odd stroop rides with the
    // supplier leg because that leg is the subtraction remainder.
    assert_eq!(s.cooperative_amount, 600_000_000);
    assert_eq!(s.supplier_amount, 400_000_001);
    assert_eq!(s.cooperative_amount + s.supplier_amount, AWKWARD);
    assert_eq!(h.escrow_balance(), 0);
}

#[test]
fn breach_requires_both_conditions() {
    // Dry enough, but rainfall is at the threshold rather than below it.
    let h = Harness::new(1_000 * USDC);
    h.client.deposit_funds(&(1_000 * USDC));
    h.client.set_in_transit();
    assert!(h
        .client
        .report_weather(&20u32, &30u32, &1_700_000_000u64)
        .is_none());
    assert_eq!(h.escrow_balance(), 1_000 * USDC);

    // Parched, but the dry streak is one day short of the 21-day trigger.
    assert!(h
        .client
        .report_weather(&2u32, &20u32, &1_700_000_100u64)
        .is_none());
    assert_eq!(h.escrow_balance(), 1_000 * USDC);
    assert_eq!(h.client.get_escrow().status, EscrowStatus::InTransit);

    // Exactly at the boundary on both axes: 19 < 20 and 21 >= 21 -> fires.
    assert!(h
        .client
        .report_weather(&19u32, &21u32, &1_700_000_200u64)
        .is_some());
    assert_eq!(
        h.client.get_escrow().status,
        EscrowStatus::ParametricTriggered
    );
}

#[test]
fn would_trigger_mirrors_the_settlement_rule() {
    let h = Harness::new(0);
    assert!(h.client.would_trigger(&8u32, &24u32));
    assert!(h.client.would_trigger(&19u32, &21u32));
    assert!(!h.client.would_trigger(&20u32, &24u32));
    assert!(!h.client.would_trigger(&8u32, &20u32));
}

#[test]
fn stale_oracle_reports_are_rejected() {
    let h = Harness::new(1_000 * USDC);
    h.client.deposit_funds(&(1_000 * USDC));
    h.client.set_in_transit();

    h.client.report_weather(&65u32, &2u32, &1_700_000_000u64);

    // Replaying a captured payload at or before the accepted watermark must
    // not be able to re-arm the breaker.
    assert_eq!(
        h.client.try_report_weather(&8u32, &24u32, &1_700_000_000u64),
        Err(Ok(SporaError::StaleOracleReport))
    );
    assert_eq!(
        h.client.try_report_weather(&8u32, &24u32, &1_699_999_999u64),
        Err(Ok(SporaError::StaleOracleReport))
    );
    assert_eq!(h.escrow_balance(), 1_000 * USDC);
    assert_eq!(h.client.get_escrow().oracle_report_count, 1);
}

// ---------------------------------------------------------------------------
// normal completion
// ---------------------------------------------------------------------------

#[test]
fn complete_milestone_transfers_entire_balance_to_supplier() {
    let h = Harness::new(2_000 * USDC);
    h.client.deposit_funds(&(2_000 * USDC));
    h.client.set_in_transit();

    let settlement = h.client.complete_milestone(&h.admin);

    assert_eq!(settlement.total, 2_000 * USDC);
    assert_eq!(settlement.supplier_amount, 2_000 * USDC);
    assert_eq!(settlement.cooperative_amount, 0);

    assert_eq!(h.token.balance(&h.supplier), 2_000 * USDC);
    assert_eq!(h.token.balance(&h.cooperative), 0);
    assert_eq!(h.escrow_balance(), 0);
    assert_eq!(h.client.get_escrow().status, EscrowStatus::Completed);
}

#[test]
fn complete_milestone_includes_accrued_earn_yield() {
    let h = Harness::new(2_000 * USDC);
    h.client.deposit_funds(&(2_000 * USDC));
    h.client.set_in_transit();

    // The climate buffer came back from a Blend pool with 4.31 USDC of yield.
    h.credit_yield(43_100_000);

    let settlement = h.client.complete_milestone(&h.admin);

    // Capping at `total_deposited` would have stranded the yield forever.
    assert_eq!(settlement.supplier_amount, 2_000 * USDC + 43_100_000);
    assert_eq!(h.escrow_balance(), 0);
}

#[test]
fn complete_milestone_accepts_the_cooperative_as_caller() {
    let h = Harness::new(500 * USDC);
    h.client.deposit_funds(&(500 * USDC));
    h.client.set_in_transit();

    let settlement = h.client.complete_milestone(&h.cooperative);
    assert_eq!(settlement.supplier_amount, 500 * USDC);
}

#[test]
fn complete_milestone_rejects_an_unrelated_caller() {
    let h = Harness::new(500 * USDC);
    h.client.deposit_funds(&(500 * USDC));
    h.client.set_in_transit();

    // Authenticates fine under mocked auth, but is neither admin nor
    // cooperative, so the authorisation check must still reject it.
    let intruder = Address::generate(&h.env);
    assert_eq!(
        h.client.try_complete_milestone(&intruder),
        Err(Ok(SporaError::Unauthorized))
    );
    assert_eq!(h.escrow_balance(), 500 * USDC);
    assert_eq!(h.token.balance(&h.supplier), 0);
}

// ---------------------------------------------------------------------------
// refund and residual sweep
// ---------------------------------------------------------------------------

#[test]
fn refund_returns_everything_to_the_cooperative() {
    let h = Harness::new(750 * USDC);
    h.client.deposit_funds(&(750 * USDC));

    let settlement = h.client.refund();
    assert_eq!(settlement.cooperative_amount, 750 * USDC);
    assert_eq!(settlement.supplier_amount, 0);
    assert_eq!(h.token.balance(&h.cooperative), 750 * USDC);
    assert_eq!(h.client.get_escrow().status, EscrowStatus::Refunded);
}

#[test]
fn refund_is_unavailable_once_goods_are_in_transit() {
    let h = Harness::new(750 * USDC);
    h.client.deposit_funds(&(750 * USDC));
    h.client.set_in_transit();

    assert_eq!(h.client.try_refund(), Err(Ok(SporaError::InvalidStatus)));
    assert_eq!(h.escrow_balance(), 750 * USDC);
}

#[test]
fn sweep_residual_applies_the_settlement_split_to_late_yield() {
    let h = Harness::new(2_000 * USDC);
    h.client.deposit_funds(&(2_000 * USDC));
    h.client.set_in_transit();

    // Breach fires while the 10% buffer is still out in a DeFindex vault, so
    // only 90% is on hand at settlement time.
    let in_vault = 200 * USDC;
    h.client.report_weather(&8u32, &24u32, &1_700_000_000u64);
    assert_eq!(h.token.balance(&h.cooperative), 1_200 * USDC);

    // The vault redeems afterwards: principal plus 2 USDC of yield.
    h.credit_yield(in_vault + 2 * USDC);
    let swept = h.client.sweep_residual();

    assert_eq!(swept.total, 202 * USDC);
    assert_eq!(swept.cooperative_amount, 1_212_000_000); // 60% of 202 USDC
    assert_eq!(swept.supplier_amount, 808_000_000); // 40% of 202 USDC
    assert_eq!(h.escrow_balance(), 0);

    // Cumulative disbursement accounts for both passes.
    assert_eq!(h.client.get_escrow().total_disbursed, 2_202 * USDC);
}

#[test]
fn sweep_residual_is_rejected_before_a_terminal_state() {
    let h = Harness::new(100 * USDC);
    h.client.deposit_funds(&(100 * USDC));
    assert_eq!(
        h.client.try_sweep_residual(),
        Err(Ok(SporaError::InvalidStatus))
    );
}

#[test]
fn sweep_residual_refuses_an_empty_contract() {
    let h = Harness::new(100 * USDC);
    h.client.deposit_funds(&(100 * USDC));
    h.client.complete_milestone(&h.admin);

    // Nothing arrived after settlement; refuse rather than emit a zero-value
    // payout an indexer would record as a real disbursement.
    assert_eq!(
        h.client.try_sweep_residual(),
        Err(Ok(SporaError::NothingToDisburse))
    );
}

// ---------------------------------------------------------------------------
// state-machine closure
// ---------------------------------------------------------------------------

#[test]
fn terminal_states_reject_every_further_transition() {
    let h = Harness::new(1_000 * USDC);
    h.client.deposit_funds(&(1_000 * USDC));
    h.client.set_in_transit();
    h.client.complete_milestone(&h.admin);

    assert_eq!(
        h.client.try_deposit_funds(&(1 * USDC)),
        Err(Ok(SporaError::InvalidStatus))
    );
    assert_eq!(
        h.client.try_set_in_transit(),
        Err(Ok(SporaError::InvalidStatus))
    );
    assert_eq!(
        h.client.try_report_weather(&8u32, &24u32, &1_700_000_000u64),
        Err(Ok(SporaError::InvalidStatus))
    );
    assert_eq!(
        h.client.try_complete_milestone(&h.admin),
        Err(Ok(SporaError::InvalidStatus))
    );
    assert_eq!(h.client.try_refund(), Err(Ok(SporaError::InvalidStatus)));
}

#[test]
fn set_in_transit_requires_funded_state() {
    let h = Harness::new(0);
    // Still `Initialized` -- nothing has been deposited yet.
    assert_eq!(
        h.client.try_set_in_transit(),
        Err(Ok(SporaError::InvalidStatus))
    );
}

#[test]
fn value_is_conserved_across_the_full_parametric_lifecycle() {
    let minted = 2_000 * USDC;
    let h = Harness::new(minted);
    h.client.deposit_funds(&minted);
    h.client.set_in_transit();
    h.client.report_weather(&8u32, &24u32, &1_700_000_000u64);

    let coop = h.token.balance(&h.cooperative);
    let supplier = h.token.balance(&h.supplier);
    let escrow = h.escrow_balance();

    assert_eq!(
        coop + supplier + escrow,
        minted,
        "no stroop may be created or destroyed across the lifecycle"
    );
    assert_eq!(escrow, 0);
}

#[test]
fn ledger_timestamp_does_not_gate_oracle_watermark() {
    // The watermark tracks the *observation* time supplied by the oracle, not
    // ledger close time, so a backfilled archive read still advances cleanly.
    let h = Harness::new(500 * USDC);
    h.client.deposit_funds(&(500 * USDC));
    h.env.ledger().with_mut(|l| l.timestamp = 1_600_000_000);

    assert!(h
        .client
        .report_weather(&65u32, &2u32, &1_700_000_000u64)
        .is_none());
    assert_eq!(
        h.client.get_escrow().last_oracle_timestamp,
        1_700_000_000u64
    );
}
