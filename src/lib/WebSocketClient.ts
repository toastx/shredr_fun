import type { WebSocketMessage } from './types';
import { HELIUS_WSS_URL } from './constants';

/**
 * WebSocket client for real-time transaction monitoring
 */
export class WebSocketClient {
    private ws: WebSocket | null = null;
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 5;
    private reconnectDelay = 1000;
    private messageHandlers: ((data: any) => void)[] = [];
    private connectionHandlers: ((connected: boolean) => void)[] = [];

    /**
      * Connect to the Cloudflare Proxy
      */
    connect(): void {
        if (this.ws?.readyState === WebSocket.OPEN) return;

        // Change http://... to ws://... (your Cloudflare Worker URL)
        console.log('Connecting to Proxy WS:', HELIUS_WSS_URL);

        this.ws = new WebSocket(HELIUS_WSS_URL);

        this.ws.onopen = () => {
            console.log('Connected to Proxy');
            this.reconnectAttempts = 0;
            this.connectionHandlers.forEach(h => h(true));
        };

        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                // Solana updates come in as 'accountNotification'
                this.messageHandlers.forEach(h => h(data));
            } catch (e) {
                console.error('WS Parse Error:', e);
            }
        };

        this.ws.onclose = () => {
            this.connectionHandlers.forEach(h => h(false));
            if (this.reconnectAttempts < this.maxReconnectAttempts) {
                this.scheduleReconnect();
            }
        };
    }
    
    /**
      * Subscribe to a Burner Wallet's updates
      * This is the "Temp Mail" logic - no management credits used!
      */
    subscribeToAccount(address: string) {
        if (!this.isConnected()) return;

        const request = {
            jsonrpc: "2.0",
            id: 1,
            method: "accountSubscribe",
            params: [
                address,
                {
                    encoding: "jsonParsed",
                    commitment: "confirmed"
                }
            ]
        };

        this.ws?.send(JSON.stringify(request));
        console.log(`Subscribed to: ${address}`);
    }

    /**
     * Disconnect from the WebSocket server
     */
    disconnect(): void {
        if (this.ws) {
            this.ws.close(1000, 'Client disconnect');
            this.ws = null;
        }
        this.reconnectAttempts = 0;
    }

    /**
     * Check if WebSocket is connected
     */
    isConnected(): boolean {
        return this.ws?.readyState === WebSocket.OPEN;
    }

    /**
     * Add a message handler
     */
    onMessage(handler: (message: WebSocketMessage) => void): void {
        this.messageHandlers.push(handler);
    }

    /**
     * Remove a message handler
     */
    offMessage(handler: (message: WebSocketMessage) => void): void {
        const index = this.messageHandlers.indexOf(handler);
        if (index > -1) {
            this.messageHandlers.splice(index, 1);
        }
    }

    /**
     * Add a connection state handler
     */
    onConnectionChange(handler: (connected: boolean) => void): void {
        this.connectionHandlers.push(handler);
    }

    /**
     * Remove a connection state handler
     */
    offConnectionChange(handler: (connected: boolean) => void): void {
        const index = this.connectionHandlers.indexOf(handler);
        if (index > -1) {
            this.connectionHandlers.splice(index, 1);
        }
    }

    /**
     * Schedule a reconnect attempt with exponential backoff
     */
    private scheduleReconnect(): void {
        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

        console.log(`Scheduling reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);

        setTimeout(() => {
            this.connect();
        }, delay);
    }
}

// Singleton instance
export const webSocketClient = new WebSocketClient();