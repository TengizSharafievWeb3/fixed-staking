import * as anchor from "@project-serum/anchor";
import { PublicKey, Keypair } from '@solana/web3.js';
import { Program, web3, BN } from "@project-serum/anchor";
import { Staking } from "../target/types/staking";
import {
  initializeProgram,
  pause,
  unpause,
  open,
  close,
  creatMintIfRequired,
  createToken,
  mintTo,
  mintToATA, tokenBalance, stakingAccount, waitUntilblockTime, blockTimeFromTx, vaultBalance, rewardBalance, getATA
} from './utils';

import { expect } from 'chai';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

import * as fs from "fs";

chai.use(chaiAsPromised);

describe("basic staking", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(
    anchor.AnchorProvider.local(
      "http://localhost:8899",
      {commitment: "confirmed", preflightCommitment: "confirmed"})
  );
  //anchor.setProvider(anchor.AnchorProvider.env());

  const provider = anchor.getProvider();

  const program = anchor.workspace.Staking as Program<Staking>;
  const spl_program = anchor.Spl.token();

  const pool = Keypair.generate();
  const authority = Keypair.generate();

  const rawdata = fs.readFileSync('tests/keys/mint.json');
  const keyData = JSON.parse(rawdata.toString());
  const mint = Keypair.fromSecretKey(new Uint8Array(keyData));

  const user1 = Keypair.generate();
  const user2 = Keypair.generate();
  const user3 = Keypair.generate();

  before(async() => {
    const funderToken = Keypair.generate();

    await creatMintIfRequired(spl_program, mint, provider.wallet.publicKey);
    await createToken(spl_program, funderToken, mint.publicKey, provider.wallet.publicKey);
    await mintTo(spl_program, 1_000_000_000, mint.publicKey, funderToken.publicKey, provider.wallet.publicKey);

    const tiers = [
      {
        supply: 3,
        slots: 3,
        stake: new BN(5_000_000),
        duration: new BN(5),
        reward: new BN(5_000_000),
      },
      {
        supply: 3,
        slots: 3,
        stake: new BN(10_000_000),
        duration: new BN(10),
        reward: new BN(10_000_000),
      },
      {
        supply: 3,
        slots: 3,
        stake: new BN(15_000_000),
        duration: new BN(15),
        reward: new BN(15_000_000),
      },
    ];

    await initializeProgram(program, pool, authority.publicKey,
      provider.wallet.publicKey, mint.publicKey, tiers);


    const [rewardVault, _nonce2] = await PublicKey.findProgramAddress(
      [anchor.utils.bytes.utf8.encode("reward"), pool.publicKey.toBuffer()],
      program.programId
    );

    await spl_program.methods.transfer(new BN(1000_000_000))
      .accounts({
        source: funderToken.publicKey,
        destination: rewardVault,
        authority: provider.wallet.publicKey,
      })
      .postInstructions(
        [
          web3.SystemProgram.transfer({
            fromPubkey: provider.wallet.publicKey,
            lamports: web3.LAMPORTS_PER_SOL,
            toPubkey: user1.publicKey
          }),
          web3.SystemProgram.transfer({
            fromPubkey: provider.wallet.publicKey,
            lamports: web3.LAMPORTS_PER_SOL,
            toPubkey: user2.publicKey
          }),
          web3.SystemProgram.transfer({
            fromPubkey: provider.wallet.publicKey,
            lamports: web3.LAMPORTS_PER_SOL,
            toPubkey: user3.publicKey
          })
        ]
      )
      .rpc();

    await mintToATA(spl_program, user1.publicKey, new BN(30_000_000), mint.publicKey, provider.wallet.publicKey);
  });

  it("Should stake", async () => {
    const user1ata = await getATA(user1.publicKey, mint.publicKey);

    const ataBalanceBefore = await tokenBalance(spl_program, user1ata);

    let poolAccount = await program.account.pool.fetch(pool.publicKey);
    expect(poolAccount.tiers[0].slots).to.be.equal(3);

    const tx = await program.methods.stake({tier500:{}})
      .accounts({
        pool: pool.publicKey,
        authority: user1.publicKey,
        from: user1ata,
      })
      .preInstructions(
        [
          await program.methods.createUser()
            .accounts({
              pool: pool.publicKey,
              authority: user1.publicKey,
            }).instruction()
        ]
      )
      .signers([user1])
      .rpc({commitment:'confirmed'});

    const ataBalanceAfter = await tokenBalance(spl_program, user1ata);
    expect(ataBalanceBefore - ataBalanceAfter).to.be.equal(5_000_000);

    poolAccount = await program.account.pool.fetch(pool.publicKey);
    expect(poolAccount.tiers[0].slots).to.be.equal(2);
    expect(poolAccount.metrics.rewardRequirements.toNumber()).to.be.equal(5_000_000);

    expect(await vaultBalance(spl_program, pool.publicKey, program.programId)).to.be.equal(5_000_000);

    const user1stakingAccount = await stakingAccount(program, pool.publicKey, user1.publicKey);
    const blockTime = await blockTimeFromTx(provider, tx);

    expect(user1stakingAccount.stakes[0].staking.lastClaimed.toNumber()).to.be.equal(blockTime);
    expect(user1stakingAccount.stakes[0].staking.lockedUntil.toNumber()).to.be.equal(blockTime + poolAccount.tiers[0].duration.toNumber());
  });

  it("Should NOT unstake before lock time", async () => {
    const ata = await getATA(user1.publicKey, mint.publicKey);

    await expect(program.methods.unstake({tier500:{}})
      .accounts({
        pool: pool.publicKey,
        authority: user1.publicKey,
        to: ata,
      })
      .signers([user1])
      .rpc()).to.be.rejectedWith(/The time lock has not yet passed/);
  })

  it("Should NOT stake if already staked (StakeStatus == Staking { .. })", async() => {
    const ata = await getATA(user1.publicKey, mint.publicKey);

    const staking = await stakingAccount(program, pool.publicKey, user1.publicKey);
    expect(staking.stakes[0]).to.have.property('staking');

    await expect(program.methods.stake({tier500:{}})
      .accounts({
        pool: pool.publicKey,
        authority: user1.publicKey,
        from: ata,
      }).signers([user1]).rpc())
      .to.be.rejectedWith(/Tier already used/);
  });

  it("Should NOT claim if there are no reward", async() => {
    const ata = await getATA(user1.publicKey, mint.publicKey);

    await expect(
      program.methods.claim()
      .accounts({
        pool: pool.publicKey,
        authority: user1.publicKey,
        to: ata,
      })
      .signers([user1])
      .postInstructions(
        [
          await program.methods.claim()
            .accounts({
              pool: pool.publicKey,
              authority: user1.publicKey,
              to: ata,
            }).instruction()
        ]
      )
      .rpc()
    ).to.be.rejectedWith(/Amount must be greater than zero/);
  });

  it("Should NOT claim if paused", async () => {
    const ata = await getATA(user1.publicKey, mint.publicKey);

    await pause(program, pool.publicKey, authority);

    await expect(program.methods.claim()
      .accounts({
        pool: pool.publicKey,
        authority: user1.publicKey,
        to: ata,
      })
      .signers([user1])
      .rpc()).to.be.rejectedWith(/Pool is paused/);

    await unpause(program, pool.publicKey, authority);

  });

  it("Should NOT unstake if pending reward", async () => {
    const ata = await getATA(user1.publicKey, mint.publicKey);

    let staking = await stakingAccount(program, pool.publicKey, user1.publicKey);
    const lockedUntil = staking.stakes[0].staking.lockedUntil.toNumber();
    await waitUntilblockTime(provider, lockedUntil + 2);

    await expect(
      program.methods.unstake({tier500:{}})
      .accounts({
        pool: pool.publicKey,
        authority: user1.publicKey,
        to: ata,
      })
      .signers([user1])
      .rpc()
    ).to.be.rejectedWith(/There is pending reward/);
  })

  it("Should claim - whole reward for stake (tier1)", async () => {
    // check user1 token account balance before claim
    const user1ata = await getATA(user1.publicKey, mint.publicKey);
    const ataBalanceBefore = await tokenBalance(spl_program, user1ata);

    let user1stakingAccount = await stakingAccount(program, pool.publicKey, user1.publicKey);
    const lockedUntil = user1stakingAccount.stakes[0].staking.lockedUntil.toNumber();

    const rewardBalanceBefore = await rewardBalance(spl_program, pool.publicKey, program.programId);

    await waitUntilblockTime(provider, lockedUntil);

    const tx = await program.methods.claim()
      .accounts({
        pool: pool.publicKey,
        authority: user1.publicKey,
        to: user1ata,
      })
      .signers([user1])
      .rpc({commitment:'confirmed'});

    expect(await blockTimeFromTx(provider, tx)).to.be.gte(lockedUntil);

    const ataBalanceAfter = await tokenBalance(spl_program, user1ata);
    expect(ataBalanceAfter - ataBalanceBefore).to.be.equal(5_000_000)

    const rewardBalanceAfter = await rewardBalance(spl_program, pool.publicKey, program.programId);
    expect(rewardBalanceBefore - rewardBalanceAfter).to.be.equal(5_000_000);

    user1stakingAccount = await stakingAccount(program, pool.publicKey, user1.publicKey);
    expect(user1stakingAccount.stakes[0]).to.be.deep.equal({ready:{}});
  });

  it("Should NOT stake if already staked (StakeStatus == Ready)", async() => {
    const ata = await getATA(user1.publicKey, mint.publicKey);

    const staking = await stakingAccount(program, pool.publicKey, user1.publicKey);
    expect(staking.stakes[0]).to.have.property('ready');

    await expect(program.methods.stake({tier500:{}})
      .accounts({
        pool: pool.publicKey,
        authority: user1.publicKey,
        from: ata,
      }).signers([user1]).rpc())
      .to.be.rejectedWith(/Tier already used/);
  });

  it("Should NOT claim if StakeStatus == Ready", async () => {
    const ata = await getATA(user1.publicKey, mint.publicKey);

    const staking = await stakingAccount(program, pool.publicKey, user1.publicKey);
    expect(staking.stakes[0]).to.have.property('ready')

    await expect(program.methods.claim()
      .accounts({
        pool: pool.publicKey,
        authority: user1.publicKey,
        to: ata,
      }).signers([user1]).rpc())
      .to.be.rejectedWith(/The user doesn't have any stakes/);
  });

  it ("Should NOT unstake if paused", async () => {
    const ata = await getATA(user1.publicKey, mint.publicKey);

    await pause(program, pool.publicKey, authority);

    await expect(program.methods.claim()
      .accounts({
        pool: pool.publicKey,
        authority: user1.publicKey,
        to: ata,
      }).signers([user1]).rpc())
      .to.be.rejectedWith(/Pool is paused/);

    await unpause(program, pool.publicKey, authority);
  });

  it("Should unstake", async() => {
    const user1ata = await getATA(user1.publicKey, mint.publicKey);

    const userBalanceBefore = await tokenBalance(spl_program, user1ata);

    let user1stakingAccount = await stakingAccount(program, pool.publicKey, user1.publicKey);
    expect(user1stakingAccount.stakes[0]).to.be.deep.equal({ready:{}});

    const vaultBalanceBefore = await vaultBalance(spl_program, pool.publicKey, program.programId);

    await program.methods.unstake({tier500:{}})
      .accounts({
        pool: pool.publicKey,
        authority: user1.publicKey,
        to: user1ata,
      })
      .signers([user1])
      .rpc({commitment:'confirmed'});

    user1stakingAccount = await stakingAccount(program, pool.publicKey, user1.publicKey);
    expect(user1stakingAccount.stakes[0]).to.be.deep.equal({used:{}});

    const vaultBalanceAfter = await vaultBalance(spl_program, pool.publicKey, program.programId);
    expect(vaultBalanceBefore - vaultBalanceAfter).to.be.equal(5_000_000);

    const userBalanceAfter = await tokenBalance(spl_program, user1ata);
    expect(userBalanceAfter - userBalanceBefore).to.be.equal(5_000_000);
  });

  it("Should NOT claim if StakeStatus == Used", async () => {
    const ata = await getATA(user1.publicKey, mint.publicKey);

    const staking = await stakingAccount(program, pool.publicKey, user1.publicKey);
    expect(staking.stakes[0]).to.have.property('used')

    await expect(program.methods.claim()
      .accounts({
        pool: pool.publicKey,
        authority: user1.publicKey,
        to: ata,
      }).signers([user1]).rpc())
      .to.be.rejectedWith(/The user doesn't have any stakes/);
  });

  it ("Should NOT unstake if used", async() => {
    const ata = await getATA(user1.publicKey, mint.publicKey);

    const staking = await stakingAccount(program, pool.publicKey, user1.publicKey);
    expect(staking.stakes[0]).to.have.property('used');

    await expect(
      program.methods.unstake({tier500:{}})
        .accounts({
          pool: pool.publicKey,
          authority: user1.publicKey,
          to: ata,
        })
        .signers([user1])
        .rpc()
    ).to.be.rejectedWith(/The user doesn't have stake in this tier/);
  });

  it("Should NOT stake if already staked (StakeStatus == Used)", async() => {
    const ata = await getATA(user1.publicKey, mint.publicKey);

    const staking = await stakingAccount(program, pool.publicKey, user1.publicKey);
    expect(staking.stakes[0]).to.have.property('used');


    await expect(program.methods.stake({tier500:{}})
      .accounts({
        pool: pool.publicKey,
        authority: user1.publicKey,
        from: ata,
      }).signers([user1]).rpc())
      .to.be.rejectedWith(/Tier already used/);
  });

  it("Should fetch user with stakes", async () => {
    // List of authority of user accounts with stakes - Staking { .. } , Ready or Used

    // tier[0] offset
    const tierIdx = 0;
    const tierOffset = 8 + 32 + 32 + tierIdx * (1 + 24);
    // 0 - None
    // 1 - Staking
    // 2 - Ready
    // 3 - Used
    const stakeStatusBytes = anchor.utils.bytes.bs58.encode(Buffer.from([3]));

    const list = await program.account.user.all([
      {
        memcmp: { // Filter users of this pool
          offset: 8,
          bytes: pool.publicKey.toBase58(),
        }
      },
      {
        memcmp: { // Filter users with Used stakes in tier[0]
          offset: tierOffset,
          bytes: stakeStatusBytes,
        }
      },
    ])
    expect(list.length).to.be.equal(1);
  });

  it("Should NOT stake if paused", async () => {
    const ata = await getATA(user1.publicKey, mint.publicKey);

    await pause(program, pool.publicKey, authority);

    await expect(
      program.methods.stake({tier1000:{}})
        .accounts({
          pool: pool.publicKey,
          authority: user1.publicKey,
          from: ata,
        }).signers([user1]).rpc()
    ).to.be.rejectedWith(/Pool is paused/)

    await unpause(program, pool.publicKey, authority);
  });

  it("Should NOT stake if closed", async () => {
    const ata = await getATA(user1.publicKey, mint.publicKey);

    await close(program, pool.publicKey, authority);

    await expect(
      program.methods.stake({tier1000:{}})
        .accounts({
          pool: pool.publicKey,
          authority: user1.publicKey,
          from: ata,
        }).signers([user1]).rpc()
    ).to.be.rejectedWith(/Pool is closed for new staking/)

    await open(program, pool.publicKey, authority);
  });

  it("Should NOT stake without tokens", async () => {
    const token = Keypair.generate();
    await createToken(spl_program, token, mint.publicKey, user1.publicKey);
    expect(await tokenBalance(spl_program, token.publicKey)).to.be.equal(0);

    await expect(program.methods.stake({tier1000:{}})
        .accounts({
          pool: pool.publicKey,
          authority: user1.publicKey,
          from: token.publicKey,
        }).signers([user1]).rpc()).to.be.rejected;
  });

  it("Should NOT claim if StakeStatus == None", async () => {
    const user = user2;
    const ata = await mintToATA(spl_program, user.publicKey, new BN(5_000_000), mint.publicKey, provider.wallet.publicKey);

    await program.methods.createUser().accounts({
      pool: pool.publicKey,
      authority: user.publicKey,
    }).signers([user]).rpc();

    await expect(program.methods.claim().accounts({
        pool: pool.publicKey,
        authority: user.publicKey,
        to: ata,
      }).signers([user]).rpc()
    ).to.be.rejectedWith(/The user doesn't have any stakes/)
  });

  it("Should NOT unstake if StakeStatus == None", async() => {
    const user = user2;
    const ata = await mintToATA(spl_program, user.publicKey, new BN(5_000_000), mint.publicKey, provider.wallet.publicKey);

    await expect(program.methods.unstake({tier500:{}}).accounts({
        pool: pool.publicKey,
        authority: user.publicKey,
        to: ata,
      }).signers([user]).rpc()
    ).to.be.rejectedWith(/The user doesn't have stake in this tier./)
  });

  //it("Should", async () => {});
});