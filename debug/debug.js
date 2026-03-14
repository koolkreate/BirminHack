document.addEventListener('DOMContentLoaded', async () => {
    const logContainer = document.getElementById('log-container');
    const clearBtn = document.getElementById('clear-btn');

    // Load initial logs
    const response = await chrome.runtime.sendMessage({ type: 'GET_LOGS' });
    if (response && response.logs) {
        response.logs.forEach(addLogEntry);
    }

    // Listen for real-time logs
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'NEW_LOG') {
            addLogEntry(message.log);
        }
    });

    clearBtn.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' });
        logContainer.innerHTML = '';
    });

    function addLogEntry(log) {
        const div = document.createElement('div');
        div.className = `log-entry ${log.level === 'error' ? 'log-error' : ''}`;
        
        const time = new Date(log.timestamp).toLocaleTimeString();
        let html = `<span class="log-time">[${time}]</span><span class="log-msg">${log.message}</span>`;
        
        if (log.data) {
            html += `<div class="log-data">${JSON.stringify(log.data, null, 2)}</div>`;
        }
        
        div.innerHTML = html;
        logContainer.appendChild(div);
        
        // Auto scroll
        logContainer.scrollTop = logContainer.scrollHeight;
    }
});
