const RPC_URL = "https://ethereum.publicnode.com";

interface ChainData {
    nonce: number;
    balanceEth: number;
}

// Scanner-Core Risk Math
function normalize(v: number, cap: number): number {
    const normalized = 10 * (v / cap) / (1 + (v / cap));
    return Math.min(10, Math.max(0, normalized));
}

async function fetchChainData(address: string): Promise<ChainData> {
    const bodyNonce = JSON.stringify({ jsonrpc: "2.0", method: "eth_getTransactionCount", params: [address, "latest"], id: 1 });
    const bodyBalance = JSON.stringify({ jsonrpc: "2.0", method: "eth_getBalance", params: [address, "latest"], id: 2 });

    const [resNonce, resBalance] = await Promise.all([
        fetch(RPC_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: bodyNonce }).then(r => r.json()),
        fetch(RPC_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: bodyBalance }).then(r => r.json())
    ]);

    return {
        nonce: parseInt(resNonce.result, 16),
        balanceEth: parseInt(resBalance.result, 16) / 1e18
    };
}

async function scanWallet(): Promise<void> {
    const addressInput = document.getElementById('wallet') as HTMLInputElement;
    const btn = document.getElementById('scanBtn') as HTMLButtonElement;
    const results = document.getElementById('results') as HTMLDivElement;
    
    const address = addressInput.value.trim();
    
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
        alert("Please enter a valid Ethereum address.");
        return;
    }

    btn.innerText = "Scanning Blockchain...";
    btn.disabled = true;
    btn.classList.add("opacity-50");

    try {
        const { nonce, balanceEth } = await fetchChainData(address);

        let riskScore = 0;
        let status = "Safe";
        
        if (nonce > 0) {
            status = "Exposed";
            const mockExposureAge = Math.min(365, nonce * 2); 
            const mockRecentTx = Math.min(20, Math.ceil(nonce / 5));
            
            const wBalance = 0.5 * normalize(balanceEth, 5.0);
            const wAge = 0.3 * normalize(mockExposureAge, 365.0);
            const wActivity = 0.2 * normalize(mockRecentTx, 20.0);
            
            riskScore = wBalance + wAge + wActivity;
        }

        const riskPercent = (riskScore / 10) * 100;

        (document.getElementById('nonceValue') as HTMLSpanElement).innerText = nonce.toString();
        (document.getElementById('riskScore') as HTMLSpanElement).innerText = riskPercent.toFixed(1) + "%";
        
        const statusEl = document.getElementById('exposureStatus') as HTMLSpanElement;
        statusEl.innerText = status;
        statusEl.className = `font-semibold ${status === 'Safe' ? 'text-green-400' : 'text-red-400'}`;

        const riskBar = document.getElementById('riskBar') as HTMLDivElement;
        riskBar.style.width = riskPercent + "%";
        
        if(riskPercent === 0) { 
            riskBar.className = "h-2.5 rounded-full transition-all duration-1000 w-0 bg-green-500"; 
        } else if(riskPercent < 40) { 
            riskBar.className = "h-2.5 rounded-full transition-all duration-1000 bg-yellow-500"; 
        } else { 
            riskBar.className = "h-2.5 rounded-full transition-all duration-1000 bg-red-500"; 
        }

        const remediationPanel = document.getElementById('remediationPanel') as HTMLDivElement;
        if (nonce > 0) {
            remediationPanel.classList.remove('hidden');
        } else {
            remediationPanel.classList.add('hidden');
        }

        results.classList.remove('hidden');
        setTimeout(() => results.classList.remove('opacity-0'), 50);

    } catch (err) {
        alert("Network error fetching blockchain data.");
        console.error(err);
    } finally {
        btn.innerText = "Calculate Risk Score";
        btn.disabled = false;
        btn.classList.remove("opacity-50");
    }
}

// Bind the event listener programmatically since inline HTML onclick doesn't work well with TS modules
document.querySelector('#scanBtn')?.addEventListener('click', scanWallet);