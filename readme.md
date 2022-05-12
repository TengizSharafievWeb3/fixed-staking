# Fixed Staking

### Prerequisites

- (Rust) [rustup](https://www.rust-lang.org/tools/install)
- (Solana) [solan-cli](https://docs.solana.com/cli/install-solana-cli-tools) 1.9.13
- (Anchor) [anchor](https://book.anchor-lang.com/chapter_2/installation.html) 0.24.2
- (Node) [node](https://github.com/nvm-sh/nvm) 17.4.0

### Build and run tests

```bash
anchor build -- --features mock-mint
anchor test --provider.cluster localnet -- --features mock-mint
```

### Tech Spec

Users will have 3 options/tiers for locking a fixed amount of tokens for a fixed amount of time to receive a fixed number of tokens as rewards.

There will only be one round of staking and rewards i.e. wallets can enter once and leave once. There are no re-staking.

Any administrator interaction with the contract will be done by you as the developer. We don't need an administrator panel.

TIERS AND REWARDS
Tiers for locking
- 500 spots: 500 tokens for 30 days, reward 11.1 tokens pr. day (333 tokens total)
- 500 spots: 1000 tokens for 60 days, reward 16.7 tokens pr. day days (1000 tokens total)
- 1000 spots: 1500 tokens for 90 days, reward 16.7 tokens pr. days (1500 tokens total)

- The deposit amount is fixed. If a wallet deposit into the 500 tokens tier, it needs to deposit exactly 500 tokens.
- Rewards accure on a per block basis. Users can claim them immediately and as often as they want.


ENTRY INTO THE POOLS
- A wallet can do 1 entry into each tier. We think this is the easiest way to do it, but are open to other ways. The only restrictions we "need" are the amount of spots available in each tier.
- When a wallet deposit into the a tier, the number of available spots in that tier is decreased by 1.
- The number of available spots in the tier DOES NOT decrease when the user withdraw at the end of the staking period. We see this as an easy way to do this as a "one off" staking.
- We need a way to turn new entries on/off. We expect the tiers to fill within 1-2 weeks. If not we will manually stop entries.

FOR ADMINISTRATION
- We need a list of wallets and which tiers they contributed to, so we can enter them into an off chain lottery. This is "just" a simple list of everybody who entered.
- A method for emergency shutdown.
- We will fund the contract with tokens for rewards every week.