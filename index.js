const web3 = require('@solana/web3.js');
const { Connection, PublicKey, Transaction, sendAndConfirmTransaction } = web3;
const { Token } = require('@solana/spl-token');
const { Liquidity, TokenAmount, Token: RadyToken, SPL_ACCOUNT_LAYOUT } = require('@raydium-io/raydium-sdk');
const config = require('./config');
const logger = require('./logger');

// Connect to Solana network
const connection = new Connection(config.RPC_ENDPOINT, {
  commitment: 'confirmed',
  maxSupportedTransactionVersion: 0
});

// List of wallet addresses to track
const wallets = config.WALLETS_TO_TRACK;

// Object to store token purchases
const tokenPurchases = {};

async function analyzeTransaction(transaction, walletAddress) {
  if (!transaction || !transaction.meta || !transaction.meta.postTokenBalances) {
    return;
  }

  const tokenBalances = transaction.meta.postTokenBalances;
  for (const balance of tokenBalances) {
    if (balance.uiTokenAmount.uiAmount > balance.uiTokenAmount.uiAmountString) {
      // This indicates a token purchase
      const tokenAddress = balance.mint;
      if (!tokenPurchases[tokenAddress]) {
        tokenPurchases[tokenAddress] = new Set();
      }
      tokenPurchases[tokenAddress].add(walletAddress);

      if (tokenPurchases[tokenAddress].size > 1) {
        await swapTokenOnRaydium(tokenAddress);
      }
    }
  }
}


async function monitorWallets() {
  for (const walletAddress of config.WALLETS_TO_TRACK) {
    try {
      const publicKey = new web3.PublicKey(walletAddress);
      const transactions = await connection.getSignaturesForAddress(publicKey);
      
      for (const tx of transactions) {
        try {
          const transaction = await connection.getTransaction(tx.signature, {
            maxSupportedTransactionVersion: 0
          });
          await analyzeTransaction(transaction, walletAddress);
        } catch (error) {
          logger.error(`Error processing transaction ${tx.signature}:`, error);
        }
      }
    } catch (error) {
      logger.error(`Error monitoring wallet ${walletAddress}:`, error);
    }
  }
}

// Function to execute a swap on Raydium
async function swapTokenOnRaydium(tokenAddress) {
    logger.info(`Multiple wallets bought token: ${tokenAddress}. Initiating swap...`);

    try {
        // Setup accounts
        const owner = web3.Keypair.fromSecretKey(new Uint8Array(config.PRIVATE_KEY));
        const tokenAccountIn = new PublicKey(config.TOKEN_ACCOUNT_IN); // Your SOL or USDC account
        const tokenAccountOut = new PublicKey(config.TOKEN_ACCOUNT_OUT); // Your account for the token you're buying

        // Setup tokens
        const tokenIn = new RadyToken(new PublicKey(config.TOKEN_IN_MINT), 9); // e.g., USDC
        const tokenOut = new RadyToken(new PublicKey(tokenAddress), 9); // The token you're buying

        // Fetch the pool info
        const poolKeys = await Liquidity.fetchPoolKeys(connection, new PublicKey(config.RAYDIUM_POOL_ID));

        // Prepare the swap
        const { innerTransactions } = await Liquidity.makeSwapInstructions({
            connection,
            poolKeys,
            userKeys: {
                tokenAccounts: [
                    { pubkey: tokenAccountIn, accountInfo: await connection.getAccountInfo(tokenAccountIn) },
                    { pubkey: tokenAccountOut, accountInfo: await connection.getAccountInfo(tokenAccountOut) }
                ],
                owner: owner.publicKey
            },
            amountIn: new TokenAmount(tokenIn, config.AMOUNT_TO_SWAP),
            amountOut: new TokenAmount(tokenOut, 0),
            fixedSide: 'in'
        });

        // Execute the swap
        for (let innerTransaction of innerTransactions) {
            const transaction = new Transaction().add(...innerTransaction.instructions);
            const signature = await sendAndConfirmTransaction(connection, transaction, [owner]);
            logger.info(`Swap executed. Signature: ${signature}`);
        }

    } catch (error) {
        logger.error(`Error swapping token ${tokenAddress}:`, error);
    }
}

// Main loop
async function main() {
    while (true) {
        try {
            await monitorWallets();
            // Add a delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 5000));
        } catch (error) {
            logger.error('An error occurred:', error);
        }
    }
}

main().catch(console.error);