import { InitRequest, RPCMessage, RPCMessages } from '../proto/api'
import { IWitnessSocket, Logger, RPCEvent, RPCEventMap } from '../types'
import { makeRpcEvent, packRpcMessages, WitnessError } from '../utils'
import { wsMessageHandler } from './message-handler'

export class WitnessSocket implements IWitnessSocket {

	private eventTarget = new EventTarget()

	isInitialised = false

	constructor(
		protected socket: WebSocket,
		public metadata: InitRequest,
		public logger: Logger
	) {
		socket.addEventListener('error', (event: ErrorEvent) => {
			const witErr = WitnessError.fromError(
				event.error
					|| new Error(event.message)
			)
			witErr.code = 'WITNESS_ERROR_NETWORK_ERROR'

			this.dispatchRPCEvent('connection-terminated', witErr)
		})

		socket.addEventListener('close', () => (
			this.dispatchRPCEvent(
				'connection-terminated',
				new WitnessError(
					'WITNESS_ERROR_NO_ERROR',
					'connection closed'
				)
			)
		))

		socket.addEventListener('message', async({ data }) => {
			try {
				await wsMessageHandler.call(this, data)
			} catch(err) {
				this.logger.error({ err }, 'error processing message')
			}
		})
	}

	get isOpen() {
		return this.socket.readyState === this.socket.OPEN
	}

	get isClosed() {
		return this.socket.readyState === this.socket.CLOSED
			|| this.socket.readyState === this.socket.CLOSING
	}

	async sendMessage(...msgs: Partial<RPCMessage>[]) {
		if(this.isClosed) {
			throw new WitnessError(
				'WITNESS_ERROR_NETWORK_ERROR',
				'Connection closed, cannot send message'
			)
		}

		if(!this.isOpen) {
			throw new WitnessError(
				'WITNESS_ERROR_NETWORK_ERROR',
				'Wait for connection to open before sending message'
			)
		}

		const msg = packRpcMessages(...msgs)
		const bytes = RPCMessages.encode(msg).finish()

		await this.socket.send(bytes)

		return msg
	}

	dispatchRPCEvent<K extends keyof RPCEventMap>(type: K, data: RPCEventMap[K]) {
		const event = makeRpcEvent(type, data)
		this.eventTarget.dispatchEvent(event)
	}

	addEventListener<K extends keyof RPCEventMap>(type: K, listener: (data: RPCEvent<K>) => void): void {
		this.eventTarget.addEventListener(type, listener)
	}

	removeEventListener<K extends keyof RPCEventMap>(type: K, listener: (data: RPCEvent<K>) => void): void {
		this.eventTarget.removeEventListener(type, listener)
	}

	async terminateConnection(err?: Error) {
		// connection already closed
		if(this.isClosed) {
			return
		}

		try {
			const witErr = err
				? WitnessError.fromError(err)
				: new WitnessError('WITNESS_ERROR_NO_ERROR', '')
			this.dispatchRPCEvent('connection-terminated', witErr)
			if(this.isOpen) {
				await this.sendMessage({
					connectionTerminationAlert: witErr.toProto()
				})
			}
		} catch(err) {
			this.logger?.error({ err }, 'error terminating connection')
		} finally {
			this.socket.close()
		}
	}
}