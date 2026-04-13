import './style.css';
import { invoke } from '@tauri-apps/api/tauri';
import { listen } from '@tauri-apps/api/event';
import { Chart, registerables } from 'chart.js';
Chart.register(...registerables);

const startServerBtn = document.getElementById('start-server-btn');
const stopServerBtn = document.getElementById('stop-server-btn');
const serverPortInput = document.getElementById('server-port');
const serverIndicator = document.getElementById('server-indicator');

const startClientBtn = document.getElementById('start-client-btn');
const stopClientBtn = document.getElementById('stop-client-btn');
const serverIpInput = document.getElementById('server-ip');
const clientPortInput = document.getElementById('client-port');
const protocolSelect = document.getElementById('protocol');
const clientDurationInput = document.getElementById('client-duration');
const clientSizeInput = document.getElementById('client-size');
const clientParallelInput = document.getElementById('client-parallel');
const clientIntervalInput = document.getElementById('client-interval');
const clientInfiniteInput = document.getElementById('client-infinite');
const clientIndicator = document.getElementById('client-indicator');

const logContainer = document.getElementById('logContainer');
const clearLogsBtn = document.getElementById('clear-logs-btn');

const historyModal = document.getElementById('historyModal');
const historyList = document.getElementById('history-list');
const speedChartCanvas = document.getElementById('speedChart');
const historyBtn = document.getElementById('history-btn');
const closeHistoryBtn = document.getElementById('close-history-btn');

let speedChart;
let time = 0;
let unlisteners = [];
let isServerLooping = false;
let currentServerPort = 5201;
let consecutiveShortSessions = 0;
let sessionStartTime = 0;

function initializeChart() {
    const ctx = speedChartCanvas.getContext('2d');
    Chart.defaults.color = '#6b7280';
    Chart.defaults.font.family = "'JetBrains Mono', monospace";
    
    speedChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Bandwidth (Mbits/sec)',
                data: [],
                borderColor: '#10b981',
                backgroundColor: 'rgba(16, 185, 129, 0.15)',
                borderWidth: 2,
                pointBackgroundColor: '#10b981',
                pointBorderColor: '#064e3b',
                pointBorderWidth: 1,
                pointRadius: 2,
                pointHoverRadius: 4,
                tension: 0.4,
                fill: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 400, easing: 'easeOutQuart' },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: { color: 'rgba(255, 255, 255, 0.04)', drawBorder: false },
                    border: { display: false }
                },
                x: {
                    grid: { color: 'rgba(255, 255, 255, 0.04)', drawBorder: false },
                    border: { display: false },
                    ticks: { maxTicksLimit: 10 }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(17, 24, 39, 0.9)',
                    titleColor: '#10b981',
                    bodyColor: '#f3f4f6',
                    borderColor: 'rgba(55, 65, 81, 1)',
                    borderWidth: 1,
                    padding: 10,
                    displayColors: false,
                    callbacks: {
                        label: function(context) { return `${context.parsed.y.toFixed(2)} Mbits/sec`; }
                    }
                }
            }
        }
    });
}

function resetChart() {
    if (speedChart) {
        speedChart.data.labels = [];
        speedChart.data.datasets[0].data = [];
        speedChart.update();
        time = 0;
    }
}

function clearLogs() {
    logContainer.innerHTML = '<p class="text-gray-500 italic">Logs cleared. Ready...</p>';
    resetChart();
}

function showHistory() {
    historyModal.classList.remove('hidden');
    historyModal.classList.add('flex');
    refreshHistory();
}

function closeHistory() {
    historyModal.classList.add('hidden');
    historyModal.classList.remove('flex');
}

historyBtn.addEventListener('click', showHistory);
closeHistoryBtn.addEventListener('click', closeHistory);
clearLogsBtn.addEventListener('click', clearLogs);

function addLog(message) {
    if (logContainer.querySelector('p.text-gray-500.italic')) {
        logContainer.innerHTML = '';
    }
    const p = document.createElement('p');
    p.textContent = message;
    
    if (message.startsWith('ERROR:')) {
        p.className = 'text-red-400 font-bold mt-2';
    } else if (message.startsWith('DONE:')) {
        p.className = 'text-blue-400 font-bold mt-2 border-t border-gray-800 pt-2';
    } else if (message.includes('Starting iperf') || message.includes('Restarting iperf')) {
        p.className = 'text-emerald-400 font-bold mb-2 pb-2 mt-4 border-b border-gray-800';
    }
    
    logContainer.appendChild(p);
    logContainer.scrollTop = logContainer.scrollHeight;
}

// Extract essential stats for history rendering
function parseSessionSpeed(results) {
    const senderMatch = results.match(/(\d+\.\d+)\s+(MBytes|GBytes|KBytes|Bytes)\s+([\d\.]+)\s+(Mbits\/sec|Gbits\/sec|Kbits\/sec|bits\/sec)\s+sender/);
    const receiverMatch = results.match(/(\d+\.\d+)\s+(MBytes|GBytes|KBytes|Bytes)\s+([\d\.]+)\s+(Mbits\/sec|Gbits\/sec|Kbits\/sec|bits\/sec)\s+receiver/);
    
    if (senderMatch) return `${senderMatch[3]} ${senderMatch[4]}`;
    if (receiverMatch) return `${receiverMatch[3]} ${receiverMatch[4]}`;
    
    // For single interval logic without final summary:
    const avgMatch = [...results.matchAll(/([\d\.]+)\s+(Mbits\/sec|Gbits\/sec|Kbits\/sec|bits\/sec)/g)];
    if (avgMatch.length > 0) {
        const last = avgMatch[avgMatch.length - 1];
        return `${last[1]} ${last[2]}`;
    }
    
    return "N/A";
}

async function refreshHistory() {
    try {
        const history = await invoke('get_history');
        historyList.innerHTML = '';
        if (history.length === 0) {
            historyList.innerHTML = '<tr><td colspan="5" class="py-10 text-center italic text-gray-500">No session history found.</td></tr>';
            return;
        }
        
        history.forEach(session => {
            const timestamp = new Date(session.timestamp).toLocaleString();
            const mode = session.mode;
            const ip = session.ip;
            const speed = parseSessionSpeed(session.results);
            
            const tr = document.createElement('tr');
            tr.className = "hover:bg-gray-800/30 transition-colors group";
            tr.innerHTML = `
                <td class="py-3 px-4 text-gray-400 align-middle">${timestamp}</td>
                <td class="py-3 px-4 align-middle">
                    <span class="px-2 py-0.5 rounded-full text-[10px] uppercase font-bold
                        ${mode === 'Server' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-blue-500/20 text-blue-400 border border-blue-500/30'}">
                        ${mode}
                    </span>
                </td>
                <td class="py-3 px-4 text-gray-300 align-middle">${ip}</td>
                <td class="py-3 px-4 text-right font-bold text-emerald-400 align-middle">${speed}</td>
                <td class="py-3 px-4 text-center align-middle">
                    <button class="delete-history-btn text-gray-500 hover:text-red-400 py-1 px-2 rounded opacity-0 group-hover:opacity-100 transition-all border border-transparent hover:border-red-500/30 bg-transparent hover:bg-red-500/10" title="Delete Session" data-id="${session.id}">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                    </button>
                </td>
            `;
            historyList.appendChild(tr);
        });

        document.querySelectorAll('.delete-history-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = parseInt(e.currentTarget.getAttribute('data-id'), 10);
                if (!isNaN(id)) {
                    try {
                        await invoke('delete_session', { id });
                        refreshHistory();
                    } catch(err) {
                        console.error(err);
                    }
                }
            });
        });
    } catch (error) {
        historyList.innerHTML = `<tr><td colspan="5" class="text-red-400 p-4">Error loading history: ${error}</td></tr>`;
    }
}

async function cleanupListeners() {
    for (let unlisten of unlisteners) {
        unlisten();
    }
    unlisteners = [];
}

async function setupListeners() {
    await cleanupListeners();
    const unlistenLog = await listen('iperf-log', (event) => {
        const line = event.payload;
        addLog(line);
        
        const match = line.match(/(\d+\.\d+)-(\d+\.\d+)\s+sec\s+[\d\.]+\s+[KMG]?Bytes\s+([\d\.]+)\s+(Mbits\/sec|Gbits\/sec|Kbits\/sec|bits\/sec)/);
        if (match) {
            const end_time = parseFloat(match[2]);
            const bandwidth = parseFloat(match[3]);
            const unit = match[4];
            
            let bandwidthMbits = bandwidth;
            if (unit === 'Gbits/sec') {
                bandwidthMbits *= 1000;
            } else if (unit === 'Kbits/sec') {
                bandwidthMbits /= 1000;
            } else if (unit === 'bits/sec') {
                bandwidthMbits /= 1000000;
            }
            
            if (end_time > time && (end_time - parseFloat(match[1])) <= 2.0) {
                time = end_time;
                speedChart.data.labels.push(time.toFixed(1) + 's');
                speedChart.data.datasets[0].data.push(bandwidthMbits);
                speedChart.update('none'); 
            }
        }
    });
    
    const unlistenError = await listen('iperf-error', (event) => {
        addLog(`ERROR: ${event.payload}`);
    });
    
    const unlistenDone = await listen('iperf-done', async (event) => {
        addLog(`DONE: ${event.payload}`);
        refreshHistory();
        
        // Handle Server Auto-Restart
        if (isServerLooping && event.payload.includes("Server")) {
            const sessionDuration = (Date.now() - sessionStartTime) / 1000;
            
            if (sessionDuration < 2) {
                consecutiveShortSessions++;
            } else {
                consecutiveShortSessions = 0;
            }

            if (consecutiveShortSessions >= 3) {
                addLog("ERROR: Server is crashing repeatedly. Breaking auto-restart loop.");
                stopServerFlow();
            } else {
                addLog(`Restarting iperf server session on port ${currentServerPort}...`);
                try {
                    sessionStartTime = Date.now();
                    await invoke('start_server', { port: currentServerPort });
                } catch (err) {
                    addLog(`ERROR: Failed to restart server: ${err}`);
                    stopServerFlow();
                }
            }
        } else {
            // Release client UI
            startClientBtn.classList.remove('hidden');
            stopClientBtn.classList.add('hidden');
            clientIndicator.classList.remove('bg-blue-500', 'animate-pulse');
        }
    });
    
    unlisteners.push(unlistenLog, unlistenError, unlistenDone);
}

async function stopServerFlow() {
    isServerLooping = false;
    startServerBtn.classList.remove('hidden');
    stopServerBtn.classList.add('hidden');
    serverIndicator.classList.remove('bg-emerald-500', 'animate-pulse');
    addLog('Server loop mode deactivated.');
    try {
        await invoke('stop_test', { mode: 'server' });
    } catch(err) {
        addLog(`ERROR stopping server: ${err}`);
    }
}

startServerBtn.addEventListener('click', async () => {
    currentServerPort = parseInt(serverPortInput.value, 10);
    isServerLooping = true;
    
    startServerBtn.classList.add('hidden');
    stopServerBtn.classList.remove('hidden');
    serverIndicator.classList.add('bg-emerald-500', 'animate-pulse');
    
    addLog(`Starting iperf server loop on port ${currentServerPort}...`);
    
    await setupListeners();
    try {
        consecutiveShortSessions = 0;
        sessionStartTime = Date.now();
        await invoke('start_server', { port: currentServerPort });
    } catch (error) {
        addLog(`ERROR: ${error}`);
        stopServerFlow();
    }
});

stopServerBtn.addEventListener('click', stopServerFlow);

async function stopClientFlow() {
    try {
        await invoke('stop_test', { mode: 'client' });
    } catch(err) {
        addLog(`ERROR stopping client: ${err}`);
    }
}
stopClientBtn.addEventListener('click', stopClientFlow);

// Settings Persistence
const settingInputs = [
    { el: serverPortInput, key: 'server-port' },
    { el: serverIpInput, key: 'server-ip' },
    { el: clientPortInput, key: 'client-port' },
    { el: protocolSelect, key: 'protocol' },
    { el: clientDurationInput, key: 'client-duration' },
    { el: clientSizeInput, key: 'client-size' },
    { el: clientParallelInput, key: 'client-parallel' },
    { el: clientIntervalInput, key: 'client-interval' }
];

settingInputs.forEach(({ el, key }) => {
    el.addEventListener('change', async () => {
        try {
            await invoke('save_setting', { key, value: el.value.toString() });
        } catch(e) {
            console.error('Failed to save setting', e);
        }
    });
});

clientInfiniteInput.addEventListener('change', async (e) => {
    try {
        await invoke('save_setting', { key: 'client-infinite', value: e.target.checked.toString() });
    } catch(err) {
        console.error(err);
    }
    const isInf = e.target.checked;
    clientDurationInput.disabled = isInf;
    
    if (isInf) {
        clientDurationInput.classList.add('opacity-30', 'cursor-not-allowed');
    } else {
        clientDurationInput.classList.remove('opacity-30', 'cursor-not-allowed');
    }
});

startClientBtn.addEventListener('click', async () => {
    const ip = serverIpInput.value;
    const port = parseInt(clientPortInput.value, 10);
    const protocol = protocolSelect.value;
    const duration = clientDurationInput.value ? parseInt(clientDurationInput.value, 10) : 10;
    const size = clientSizeInput.value.trim();
    const parallel = clientParallelInput.value ? parseInt(clientParallelInput.value, 10) : 1;
    const interval = clientIntervalInput.value ? parseInt(clientIntervalInput.value, 10) : 1;
    const infinite = clientInfiniteInput.checked;

    if (!ip) {
        addLog('ERROR: Please enter a server IP.');
        return;
    }
    
    // Auto-clear logs and reset chart for each new test
    clearLogs();

    addLog(`Starting iperf client test for ${ip}:${port} (${protocol.toUpperCase()})...`);
    startClientBtn.classList.add('hidden');
    stopClientBtn.classList.remove('hidden');
    clientIndicator.classList.add('bg-blue-500', 'animate-pulse');

    await setupListeners();
    try {
        await invoke('start_client', { 
            options: {
                ip, 
                port, 
                protocol, 
                duration: duration || null, 
                size: size || null, 
                infinite, 
                parallel, 
                interval: interval || null
            } 
        });
    } catch (error) {
        addLog(`ERROR: ${error}`);
        startClientBtn.classList.remove('hidden');
        stopClientBtn.classList.add('hidden');
        clientIndicator.classList.remove('bg-blue-500', 'animate-pulse');
    }
});

// Initialization routines
async function loadSettings() {
    try {
        const settings = await invoke('get_all_settings');
        
        settingInputs.forEach(({ el, key }) => {
            if (settings[key] !== undefined) {
                el.value = settings[key];
            }
        });
        
        if (settings['client-infinite'] !== undefined) {
            const isInf = settings['client-infinite'] === 'true';
            clientInfiniteInput.checked = isInf;
            clientDurationInput.disabled = isInf;
            if (isInf) {
                clientDurationInput.classList.add('opacity-30', 'cursor-not-allowed');
            } else {
                clientDurationInput.classList.remove('opacity-30', 'cursor-not-allowed');
            }
        }
    } catch(e) {
        console.error('Failed to load settings', e);
    }
}

// Initial setup
loadSettings();
initializeChart();
refreshHistory();
