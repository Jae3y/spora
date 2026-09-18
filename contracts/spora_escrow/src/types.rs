use soroban_sdk::{contracterror, contracttype, Address};

/// Lifecycle of a single cross-continental input-financing escrow.
///
/// Transitions are strictly forward-only; there is no path back into
/// `Initialized` and the three terminal states (`ParametricTriggered`,
/// `Completed`, `Refunded`) accept no further value-moving calls.
///
/// ```text
///   Initialized ──deposit──▶ Funded ──set_in_transit──▶ InTransit
///                              │                          │
///                              ├──complete_milestone───────┤──▶ Completed
///                              ├──report_weather(breach)───┤──▶ ParametricTriggered
///                              └──refund (admin, pre-ship)─┴──▶ Refunded
/// ```
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EscrowStatus {
    Initialized = 0,
    Funded = 1,
    InTransit = 2,
    ParametricTriggered = 3,
    Completed = 4,
    Refunded = 5,
}

impl EscrowStatus {
    /// Terminal states hold no further claim on the contract balance.
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            EscrowStatus::ParametricTriggered | EscrowStatus::Completed | EscrowStatus::Refunded
        )
    }
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Oracle,
    Cooperative,
    Supplier,
    UsdcToken,
    Status,
    TotalDeposited,
    InputAllocation,
    BufferAllocation,
    ThresholdMm,
    ConsecutiveDryDays,
    CurrentRainfallMm,
    OrderMetadataHash,
    /// Total moved out of the contract across every disbursement path. Used to
    /// assert the conservation invariant off-chain and in tests.
    TotalDisbursed,
    /// Monotonic counter of accepted oracle reports; lets the indexer detect
    /// gaps and lets the UI show telemetry freshness.
    OracleReportCount,
    /// Ledger timestamp of the most recent accepted oracle report.
    LastOracleTimestamp,
    /// Cooperative's share, in basis points, of the settlement that closed the
    /// escrow. Persisted so `sweep_residual` can apply identical economics to
    /// yield that redeems after the terminal state was reached.
    SettlementCoopBps,
}

/// Flattened read model returned by `get_escrow`. One call, one round trip —
/// the dashboard polls this rather than issuing a dozen storage reads.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowView {
    pub status: EscrowStatus,
    pub total_deposited: i128,
    pub input_allocation: i128,
    pub buffer_allocation: i128,
    pub total_disbursed: i128,
    pub threshold_mm: u32,
    pub current_rainfall_mm: u32,
    pub consecutive_dry_days: u32,
    pub oracle_report_count: u32,
    pub last_oracle_timestamp: u64,
    pub cooperative: Address,
    pub supplier: Address,
    pub usdc_token: Address,
}

/// Exact amounts moved by a terminal disbursement. Emitted in the settlement
/// event so an indexer never has to re-derive the split from percentages.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Settlement {
    pub cooperative_amount: i128,
    pub supplier_amount: i128,
    pub total: i128,
}

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum SporaError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidStatus = 3,
    NonPositiveAmount = 4,
    MathOverflow = 5,
    /// A parametric threshold of 0 mm can never be breached (`r < 0` is
    /// unsatisfiable for u32), which would silently disarm the circuit breaker.
    InvalidThreshold = 6,
    /// Nothing to disburse — refuse rather than emit a zero-value settlement
    /// that an indexer would record as a real payout.
    NothingToDisburse = 7,
    /// Telemetry older than the reading already on record; replaying a stale
    /// signed payload must not be able to re-arm or re-trigger the breaker.
    StaleOracleReport = 8,
    /// Caller authenticated successfully but is not one of the principals
    /// permitted to take this action.
    Unauthorized = 9,
}
