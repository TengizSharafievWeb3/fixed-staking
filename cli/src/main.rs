use clap::{arg, Arg, ArgMatches, Command};
use solana_clap_utils::keypair::DefaultSigner;
use solana_client_helpers::{Client, RpcClient};
use solana_sdk::commitment_config::CommitmentConfig;
use solana_sdk::{bs58, instruction::Instruction, pubkey::Pubkey, signature::{read_keypair, Keypair}, signer::Signer, transaction::Transaction};
use std::time::Duration;
use std::{convert::TryFrom, fmt::Display, fs::File, str::FromStr, sync::Arc};
use solana_client::rpc_filter::{Memcmp, MemcmpEncodedBytes, RpcFilterType};
use anchor_lang::Discriminator;
use solana_account_decoder::UiAccountEncoding;
use solana_client::rpc_config::{RpcAccountInfoConfig, RpcProgramAccountsConfig};
use thiserror::Error;

fn pause_subcommand() -> Command<'static> {
    Command::new("pause").about("pause all operation")
}

fn unpause_subcommand() -> Command<'static> {
    Command::new("unpause").about("unpause all operation")
}

fn close_subcommand() -> Command<'static> {
    Command::new("close").about("close pool for new stakes")
}

fn open_subcommand() -> Command<'static> {
    Command::new("open").about("open pool for new stakes")
}

fn withdraw_subcommand() -> Command<'static> {
    Command::new("withdraw")
        .about("withdraw extra from vaults")
        .arg(
            Arg::new("address")
                .index(1)
                .takes_value(true)
                .required(true)
                .help("The destination token account for CSM tokens"),
        )
}

fn free_subcommand() -> Command<'static> {
    Command::new("free")
        .about("close users and pool accounts and withdraw lamports")
        .arg(
            Arg::new("address")
                .index(1)
                .takes_value(true)
                .required(true)
                .help("The destination system account for lamports"),
        )
}

#[derive(Debug, PartialEq)]
enum CliCommand {
    Pause,
    Unpause,
    Close,
    Open,
    Withdraw { address: Pubkey },
    Free { address: Pubkey },
}

impl Display for CliCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CliCommand::Pause => write!(f, "pause"),
            CliCommand::Unpause => write!(f, "unpause"),
            CliCommand::Close => write!(f, "close"),
            CliCommand::Open => write!(f, "open"),
            CliCommand::Withdraw { address } => write!(f, "withdraw {}", address),
            CliCommand::Free { address } => write!(f, "free {}", address),
        }
    }
}

impl TryFrom<&ArgMatches> for CliCommand {
    type Error = CliError;

    fn try_from(matches: &ArgMatches) -> Result<Self, Self::Error> {
        match matches.subcommand() {
            Some(("pause", _matches)) => Ok(CliCommand::Pause),
            Some(("unpause", _matches)) => Ok(CliCommand::Unpause),
            Some(("close", _matches)) => Ok(CliCommand::Close),
            Some(("open", _matches)) => Ok(CliCommand::Open),
            Some(("withdraw", matches)) => Ok(CliCommand::Withdraw {
                address: parse_pubkey("address", matches)?,
            }),
            Some(("free", matches)) => Ok(CliCommand::Free {
                address: parse_pubkey("address", matches)?,
            }),
            _ => Err(CliError::CommandNotRecognized(
                matches.subcommand().unwrap().0.into(),
            )),
        }
    }
}

fn parse_pubkey(arg: &str, matches: &ArgMatches) -> Result<Pubkey, CliError> {
    Pubkey::from_str(parse_string(arg, matches)?.as_str())
        .map_err(|_err| CliError::BadParameter(arg.into()))
}

fn parse_string(arg: &str, matches: &ArgMatches) -> Result<String, CliError> {
    Ok(matches
        .value_of(arg)
        .ok_or_else(||CliError::BadParameter(arg.into()))?
        .to_string())
}

#[derive(Debug, Error)]
enum CliError {
    #[error("Bad parameter: {0}")]
    BadParameter(String),
    #[error("Command not recognized: {0}")]
    CommandNotRecognized(String),
}

struct CliConfig {
    pub json_rpc_url: String,
    pub keypair_path: String,
    pub rpc_timeout: Duration,
    pub commitment: CommitmentConfig,
    pub confirm_transaction_initial_timeout: Duration,
}

impl CliConfig {
    pub fn load() -> Self {
        let config_file = solana_cli_config::CONFIG_FILE.as_ref().unwrap().as_str();
        let solana_config = solana_cli_config::Config::load(config_file).unwrap();

        CliConfig {
            json_rpc_url: solana_config.json_rpc_url,
            keypair_path: solana_config.keypair_path,
            rpc_timeout: Duration::from_secs(30),
            commitment: CommitmentConfig::confirmed(),
            confirm_transaction_initial_timeout: Duration::from_secs(5),
        }
    }
}

fn load_keypair(config: &CliConfig) -> Keypair {
    let signer = DefaultSigner::new("keypair", &config.keypair_path);
    read_keypair(&mut File::open(signer.path.as_str()).unwrap()).unwrap()
}

fn parse_keypair(arg: &str, matches: &ArgMatches) -> Result<Keypair, CliError> {
    read_keypair(
        &mut File::open(
            matches
                .value_of(arg)
                .ok_or_else(||CliError::BadParameter(arg.into()))?
        )
        .map_err(|_| CliError::BadParameter(arg.into()))?,
    )
    .map_err(|_| CliError::BadParameter(arg.into()))
}

fn main() -> Result<(), CliError> {
    let matches = Command::new("CSMxStaking")
        .bin_name("staking")
        .about("CSMxStaking admin tool")
        .version("0.1.0")
        .author("Tengiz Sharafiev <btolfa@gmail.com>")
        .arg(
            arg!(--pool <ADDRESS>)
                .required(true)
                .help("CSMxStaking Pool address"),
        )
        .arg(
            arg!(--authority <KEYPAIR>)
                .required(true)
                .help("CSMxStaking Pool authority"),
        )
        .subcommand_required(true)
        .subcommand(pause_subcommand())
        .subcommand(unpause_subcommand())
        .subcommand(close_subcommand())
        .subcommand(open_subcommand())
        .subcommand(withdraw_subcommand())
        .subcommand(free_subcommand())
        .get_matches();

    // Parse command and config
    let command = CliCommand::try_from(&matches)?;
    let pool = parse_pubkey("pool", &matches)?;
    let authority = parse_keypair("authority", &matches)?;

    let config = CliConfig::load();

    // Build the RPC client
    let payer = load_keypair(&config);
    let client = RpcClient::new_with_timeouts_and_commitment(
        config.json_rpc_url.to_string(),
        config.rpc_timeout,
        config.commitment,
        config.confirm_transaction_initial_timeout,
    );
    let client = Arc::new(Client { client, payer });

    println!("{:?}", command);

    match command {
        CliCommand::Pause => pause(&client, pool, &authority),
        CliCommand::Unpause => unpause(&client, pool, &authority),
        CliCommand::Close => close(&client, pool, &authority),
        CliCommand::Open => open(&client, pool, &authority),
        CliCommand::Withdraw { address } => withdraw(&client, pool, &authority, address),
        CliCommand::Free { address } => free(&client, pool, &authority, address),
    }
}

fn pause(client: &Arc<Client>, pool: Pubkey, authority: &Keypair) -> Result<(), CliError> {
    let ix = staking::instructions::pause(pool, authority.pubkey());
    sign_and_submit(client, &[ix], authority);
    Ok(())
}

fn unpause(client: &Arc<Client>, pool: Pubkey, authority: &Keypair) -> Result<(), CliError> {
    let ix = staking::instructions::unpause(pool, authority.pubkey());
    sign_and_submit(client, &[ix], authority);
    Ok(())
}

fn close(client: &Arc<Client>, pool: Pubkey, authority: &Keypair) -> Result<(), CliError> {
    let ix = staking::instructions::close(pool, authority.pubkey());
    sign_and_submit(client, &[ix], authority);
    Ok(())
}

fn open(client: &Arc<Client>, pool: Pubkey, authority: &Keypair) -> Result<(), CliError> {
    let ix = staking::instructions::open(pool, authority.pubkey());
    sign_and_submit(client, &[ix], authority);
    Ok(())
}

fn withdraw(client: &Arc<Client>, pool: Pubkey, authority: &Keypair, destionation: Pubkey) -> Result<(), CliError> {
    let ix = staking::instructions::withdraw(pool, authority.pubkey(), destionation);
    sign_and_submit(client, &[ix], authority);
    Ok(())
}

fn free(client: &Arc<Client>, pool: Pubkey, authority: &Keypair, receiver: Pubkey) -> Result<(), CliError> {
    for user in get_user_accounts(client, &pool)? {
        free_user(client, pool, authority, user, receiver)?;
    }
    free_pool(client, pool, authority, receiver)
}

fn free_user(client: &Arc<Client>, pool: Pubkey, authority: &Keypair, user: Pubkey, receiver: Pubkey) -> Result<(), CliError> {
    let ix = staking::instructions::free_user(pool, authority.pubkey(), user, receiver);
    sign_and_submit(client, &[ix], authority);
    Ok(())
}

fn free_pool(client: &Arc<Client>, pool: Pubkey, authority: &Keypair, receiver: Pubkey) -> Result<(), CliError> {
    let ix = staking::instructions::free_pool(pool, authority.pubkey(),  receiver);
    sign_and_submit(client, &[ix], authority);
    Ok(())
}

fn get_user_accounts(client: &Arc<Client>, pool: &Pubkey) -> Result<Vec<Pubkey>, CliError> {
    let account_type_filter = RpcFilterType::Memcmp(Memcmp {
        offset: 0,
        bytes: MemcmpEncodedBytes::Base58(bs58::encode(staking::state::User::discriminator()).into_string()),
        encoding: None,
    });

    let pool_filter = RpcFilterType::Memcmp(Memcmp {
        offset: 8,
        bytes: MemcmpEncodedBytes::Base58(bs58::encode(pool.to_bytes()).into_string()),
        encoding: None,
    });

    let config = RpcProgramAccountsConfig {
        filters: Some(vec![account_type_filter, pool_filter]),
        account_config: RpcAccountInfoConfig {
            encoding: Some(UiAccountEncoding::Base64),
            data_slice: None,
            commitment: None,
        },
        with_context: None,
    };

    Ok(
        client.get_program_accounts_with_config(&staking::ID, config).unwrap()
        .into_iter().map(|(key, _)| {
        key
    }).collect()
    )
}

fn sign_and_submit(client: &Arc<Client>, ixs: &[Instruction], authority: &Keypair) {
    let mut tx = Transaction::new_with_payer(ixs, Some(&client.payer_pubkey()));
    tx.sign(
        &vec![&client.payer, authority],
        client.latest_blockhash().unwrap(),
    );
    let sig = client.send_and_confirm_transaction(&tx).unwrap();
    println!(
        "Tx: {}",
        solana_explorer_url(sig.to_string())
    );
}

fn solana_explorer_url(value: String) -> String {
    let base_url = "https://explorer.solana.com";
    format!("{}/tx/{}", base_url, value)
}
