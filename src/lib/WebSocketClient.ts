import type { WebSocketMessage } from './types';
import { API_BASE_URL } from './constants';

/**
 * WebSocket client for real-time transaction monitoring
 */
export class WebSocketClient {
    private ws: WebSocket | null = null;
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 5;
    private reconnectDelay = 1000; // Start with 1 second
    private messageHandlers: ((message: WebSocketMessage) => void)[] = [];
    private connectionHandlers: ((connected: boolean) => void)[] = [];

    /**
     * Connect to the WebSocket server
     */
    connect(): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            return; // Already connected
        }

        const wsUrl = API_BASE_URL.replace('http', 'ws') + '/ws';
        console.log('Connecting to WebSocket:', wsUrl);

        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            console.log('WebSocket connected');
            this.reconnectAttempts = 0;
            this.reconnectDelay = 1000;
            this.connectionHandlers.forEach(handler => handler(true));
        };

        this.ws.onmessage = (event) => {
            try {
                const message: WebSocketMessage = JSON.parse(event.data);
                this.messageHandlers.forEach(handler => handler(message));
            } catch (error) {
                console.error('Failed to parse WebSocket message:', error);
            }
        };

        this.ws.onclose = (event) => {
            console.log('WebSocket disconnected:', event.code, event.reason);
            this.connectionHandlers.forEach(handler => handler(false));

            // Attempt to reconnect if not a clean close
            if (event.code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
                this.scheduleReconnect();
            }
        };

        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
        };
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