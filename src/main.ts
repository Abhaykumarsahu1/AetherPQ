import { migrate } from "./migrate";
// Ensure your WASM package is built and in the correct location (src/pkg)
import init, { assess_wallet } from './pkg/scanner_core.js';

const RPC_URL = "https://rpc.ankr.com/eth/562e775c874589cee2fbc157c175451b99189940efdf118aaaf9b42d55b99d3e"; 

// ---------------------------------------------------------------------------
// RPC helpers
// ---------------------------------------------------------------------------
interface RpcResponse {
    result?: string | { timestamp?: string };
    error?: { message?: string; code?: number };
}

let rpcIdCounter = 1;

async function rpcCall(method: string, params: unknown[]): Promise<any> {
    const body = JSON.stringify({
        jsonrpc: "2.0",
        method,
        params,
        id: rpcIdCounter++,
    });

    const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
    });

    const json: RpcResponse = await res.json();

    if (json.error) {
        throw new Error(`RPC error calling ${method}: ${json.error.message ?? "unknown error"}`);
    }
    if (json.result === undefined) {
        throw new Error(`RPC call to ${method} returned no result`);
    }
    return json.result;
}

function hexToBigInt(hex: string): bigint {
    return BigInt(hex ?? "0x0");
}

async function nonceAtBlock(address: string, block: bigint): Promise<bigint> {
    const blockHex = "0x" + block.toString(16);
    const result = await rpcCall("eth_getTransactionCount", [address, blockHex]);
    return hexToBigInt(result);
}

async function latestBlockNumber(): Promise<bigint> {
    const result = await rpcCall("eth_blockNumber", []);
    return hexToBigInt(result);
}

async function blockTimestamp(block: bigint): Promise<bigint> {
    const blockHex = "0x" + block.toString(16);
    const result = await rpcCall("eth_getBlockByNumber", [blockHex, false]);
    return hexToBigInt(result.timestamp);
}

// ---------------------------------------------------------------------------
// Binary Search with Live Progress Callback
// ---------------------------------------------------------------------------
async function findFirstExposureBlock(
    address: string, 
    latestBlock: bigint, 
    onProgress: (block: bigint) => void
): Promise<bigint> {
    let lo = 0n;
    let hi = latestBlock;

    while (lo < hi) {
        const mid = lo + (hi - lo) / 2n;
        onProgress(mid); 
        const nonceHere = await nonceAtBlock(address, mid);
        if (nonceHere > 0n) {
            hi = mid; 
        } else {
            lo = mid + 1n; 
        }
    }
    return lo;
}

// ---------------------------------------------------------------------------
// Phase 1: Fast Data (Balance & Nonce)
// ---------------------------------------------------------------------------
async function fetchFastData(address: string) {
    const nonceResult = await rpcCall("eth_getTransactionCount", [address, "latest"]);
    const nonce = Number(hexToBigInt(nonceResult));
    
    const balanceResult = await rpcCall("eth_getBalance", [address, "latest"]);
    const balanceEth = Number(hexToBigInt(balanceResult)) / 1e18;
    
    return { nonce, balanceEth };
}

// ---------------------------------------------------------------------------
// Phase 2: Slow Data (Archive Binary Search)
// ---------------------------------------------------------------------------
async function fetchHistoricalData(address: string, onProgress: (msg: string) => void) {
    try {
        const latestBlock = await latestBlockNumber();
        
        const firstBlock = await findFirstExposureBlock(address, latestBlock, (mid) => {
            onProgress(`Binary Search: Block ${mid.toLocaleString()}`);
        });
        
        onProgress("Calculating age...");
        const firstTs = await blockTimestamp(firstBlock);
        const nowTs = await blockTimestamp(latestBlock);
        const daysSinceFirstExposure = Number((nowTs - firstTs) / 86400n);

        onProgress("Checking 90-day activity...");
        const blocksPer90Days = BigInt(Math.floor((90 * 86400) / 12));
        const block90dAgo = latestBlock > blocksPer90Days ? latestBlock - blocksPer90Days : 0n;
        const nonce90dAgo = await nonceAtBlock(address, block90dAgo);
        
        const recentTxCountResult = await rpcCall("eth_getTransactionCount", [address, "latest"]);
        const recentTxCount = Number(hexToBigInt(recentTxCountResult)) - Number(nonce90dAgo);

        return { daysSinceFirstExposure, recentTxCount, historicalDataAvailable: true };
    } catch (err) {
        console.warn("Archive access failed:", err);
        return { daysSinceFirstExposure: null, recentTxCount: null, historicalDataAvailable: false };
    }
}

// ---------------------------------------------------------------------------
// UI wiring - Progressive Reveal, Layout Transition, Wasm Integration
// ---------------------------------------------------------------------------
async function scanWallet(): Promise<void> {
    const addressInput = document.getElementById('wallet') as HTMLInputElement;
    const btn = document.getElementById('scanBtn') as HTMLButtonElement;
    const results = document.getElementById('results') as HTMLDivElement;
    const mainContainer = document.getElementById('mainContainer') as HTMLDivElement;
    
    // NEW WASM ELEMENT (Ensure this ID is added to your index.html if you want to show recommendations)
    const recText = document.getElementById('systemRecommendationText') as HTMLParagraphElement;

    const address = addressInput.value.trim();

    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
        alert("Please enter a valid Ethereum address.");
        return;
    }

    // --- UI State - Start Scanning ---
    const originalBtnText = btn.innerText;
    btn.disabled = true;
    btn.classList.add("opacity-50");

    // ===================================================================
    // 1. LAYOUT TRANSITION: Slide from Center to Side-by-Side
    // ===================================================================
    if (mainContainer) {
        mainContainer.classList.remove('max-w-lg'); // Starts centered/small
        mainContainer.classList.add('max-w-6xl');    // Expands to allow side-by-side
    }

    // Reveal the results panel (fades in via transition-opacity duration-700)
    results.classList.remove('hidden');
    setTimeout(() => results.classList.remove('opacity-0'), 50);

    // Reset UI elements to pulsing loading state
    (document.getElementById('riskScore') as HTMLSpanElement).innerText = "Calculating...";
    (document.getElementById('riskScore') as HTMLSpanElement).className = "text-3xl font-bold text-gray-500 animate-pulse";
    (document.getElementById('valBalance') as HTMLSpanElement).innerText = "Querying...";
    (document.getElementById('valBalance') as HTMLSpanElement).className = "block font-medium text-cyan-400 animate-pulse";
    (document.getElementById('valAge') as HTMLSpanElement).innerText = "Pending...";
    (document.getElementById('valActivity') as HTMLSpanElement).innerText = "Pending...";
    (document.getElementById('riskBar') as HTMLDivElement).className = "h-full bg-cyan-500 w-full animate-pulse transition-all duration-1000";
    
    // Reset output text and hide panels
    (document.getElementById('impBalance') as HTMLSpanElement).innerText = "-";
    (document.getElementById('impAge') as HTMLSpanElement).innerText = "-";
    (document.getElementById('impActivity') as HTMLSpanElement).innerText = "-";
    document.getElementById('remediationPanel')?.classList.add('hidden');
    
    if (recText) {
        recText.innerText = "Verifying findings with Rust engine...";
        recText.className = "text-gray-300 text-sm leading-relaxed italic animate-pulse";
    }

    try {
        btn.innerText = "Phase 1: Fetching State...";
        
        // 2. Fetch and Reveal Balance Instantly
        const { nonce, balanceEth } = await fetchFastData(address);
        
        // Reveal raw data immediately
        (document.getElementById('valBalance') as HTMLSpanElement).innerText = `${balanceEth.toFixed(4)} ETH`;
        (document.getElementById('valBalance') as HTMLSpanElement).className = "block font-medium text-white";
        (document.getElementById('nonceValue') as HTMLSpanElement).innerText = nonce.toString();

        let hist: {
  daysSinceFirstExposure: null | number;
  recentTxCount: null | number;
  historicalDataAvailable: boolean;
} = {
  daysSinceFirstExposure: null,
  recentTxCount: null,
  historicalDataAvailable: false, // initial, un-fetched state
};

        // 3. Fetch Historical Data (The 7-second phase)
        if (nonce > 0) {
            (document.getElementById('valAge') as HTMLSpanElement).className = "block font-medium text-cyan-400";
            
            // Binary search provides live updates to button and Age field
            hist = await fetchHistoricalData(address, (msg) => {
                btn.innerText = msg;
                (document.getElementById('valAge') as HTMLSpanElement).innerText = msg;
            });
        } else {
            (document.getElementById('valAge') as HTMLSpanElement).innerText = "0 days (Not Exposed)";
            (document.getElementById('valActivity') as HTMLSpanElement).innerText = "0 txs (Not Exposed)";
        }

        // ===================================================================
        // 4. WASM INTEGRATION: Hand off raw data to Rust engine
        // ===================================================================
        btn.innerText = "Initializing Rust Engine...";
        await init(); // 1. Initialize Wasm memory

        btn.innerText = "Running Risk Algorithm...";
        
        // 2. Prepare the input object (matches Rust's WalletFacts struct)
        const wasmInput = {
            nonce: nonce,
            balance_eth: balanceEth,
            // Serde handles Option<u64> from TS null/number
            days_since_first_exposure: hist.daysSinceFirstExposure, 
            recent_tx_count: hist.recentTxCount ?? 0, 
        };

        // 3. Call the exported Rust function
        const report = await assess_wallet(wasmInput);

        // ===================================================================
        // 5. FINAL UI UPDATE: Apply verified Wasm outputs
        // ===================================================================
        btn.innerText = "Finalizing Score...";

        // Update Total Score and Status
        const riskPercent = report.risk_percent;
        const status = report.status; // "Safe" or "Exposed"
        
        const scoreEl = document.getElementById('riskScore') as HTMLSpanElement;
        scoreEl.innerText = riskPercent.toFixed(1) + "%";
        scoreEl.className = "text-4xl font-bold text-white transition-colors duration-500";

        const statusEl = document.getElementById('exposureStatus') as HTMLSpanElement;
        statusEl.innerText = status;
        statusEl.className = `font-semibold text-lg ${status === 'Safe' ? 'text-green-400' : 'text-red-400'}`;

        // Populate Wasm Recommendation Text
        if (recText) {
            recText.innerText = `"${report.recommendation}"`;
            recText.className = "text-white text-sm leading-relaxed font-medium transition-colors duration-500";
        }

        // Apply dynamic color thresholds to the progress bar
        const riskBar = document.getElementById('riskBar') as HTMLDivElement;
        riskBar.style.width = riskPercent + "%";
        if (riskPercent === 0) riskBar.className = "h-full transition-all duration-1000 bg-green-500";
        else if (riskPercent < 40) riskBar.className = "h-full transition-all duration-1000 bg-yellow-500";
        else riskBar.className = "h-full transition-all duration-1000 bg-red-500";

        // Update breakdown percentages sourced directly from Rust calculation
        (document.getElementById('impBalance') as HTMLSpanElement).innerText = `+${report.pct_balance.toFixed(1)}%`;
        (document.getElementById('impBalance') as HTMLSpanElement).className = "text-xs text-cyan-400 font-semibold";

        if (status === "Exposed" && hist.historicalDataAvailable) {
             (document.getElementById('valAge') as HTMLSpanElement).innerText = `${hist.daysSinceFirstExposure} days`;
             (document.getElementById('impAge') as HTMLSpanElement).innerText = `+${report.pct_age.toFixed(1)}%`;
             (document.getElementById('valActivity') as HTMLSpanElement).innerText = `${hist.recentTxCount} txs`;
             (document.getElementById('impActivity') as HTMLSpanElement).innerText = `+${report.pct_activity.toFixed(1)}%`;
        } else if (status === "Exposed" && !hist.historicalDataAvailable) {
             (document.getElementById('valAge') as HTMLSpanElement).innerText = "Archive RPC Req.";
             (document.getElementById('impAge') as HTMLSpanElement).innerText = "+0.0%";
             (document.getElementById('valActivity') as HTMLSpanElement).innerText = "Archive RPC Req.";
             (document.getElementById('impActivity') as HTMLSpanElement).innerText = "+0.0%";
        }

        // Clean up any remaining loading states
        ['valAge', 'impAge', 'valActivity', 'impActivity'].forEach(id => {
            document.getElementById(id)?.classList.remove('animate-pulse');
        });

        // Show remediation panel on left side if exposed
        if (status === "Exposed") document.getElementById('remediationPanel')?.classList.remove('hidden');

    } catch (err) {
        alert("Network error fetching blockchain data.");
        console.error(err);
    } finally {
        // Restore button state
        btn.innerText = originalBtnText;
        btn.disabled = false;
        btn.classList.remove("opacity-50");
    }
}

// Bind event listener
document.querySelector('#scanBtn')?.addEventListener('click', scanWallet);

document.getElementById("migrateBtn")?.addEventListener("click", async () => {
  const out = document.getElementById("migrateStatus")!;
  const scanned = (document.getElementById("wallet") as HTMLInputElement).value.trim();
  try {
    const r = await migrate(scanned, (s) => (out.textContent = s));
    out.textContent = `Deployed! Wallet ${r.wallet} | tx ${r.tx} | gas ${r.gasUsed}`;
  } catch (e: any) {
    out.textContent = "Failed: " + (e?.shortMessage ?? e?.message ?? String(e));
  }
});