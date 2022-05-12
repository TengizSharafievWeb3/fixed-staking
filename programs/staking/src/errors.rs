use anchor_lang::prelude::*;

#[error_code]
pub enum StakingError {
    InvalidRewardTier,
    CalcFailure,
    BumpFailure,

    #[msg("There is no available slot in this tier.")]
    NoAvailableSlotForTier,
    #[msg("Tier already used.")]
    TierAlreadyUsed,

    #[msg("The user doesn't have stake in this tier.")]
    UserDoesntHaveTier,
    #[msg("The time lock has not yet passed.")]
    TimeLockHasntYetPassed,
    #[msg("There is pending reward")]
    PendingReward,
    #[msg("The user doesn't have any stakes")]
    UserDoensntHaveStakes,

    #[msg("Pool is paused.")]
    PoolPaused,
    #[msg("Pool is closed for new staking")]
    PoolClosed,
    #[msg("Amount must be greater than zero.")]
    AmountMustBeGreaterThanZero,
    #[msg("Only extra (total - required) withdraw allowed")]
    OnlyExtraWithdrawAllowed,

    UserHasActiveStakes,
    AmountMustBeZero,
    PoolHasToBeClosed,
}
