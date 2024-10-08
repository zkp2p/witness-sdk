import { IncomingMessage } from 'http'
import { promisify } from 'util'
import { WebSocket as WS } from 'ws'
import { handleMessage } from '../client/message-handler'
import { WitnessSocket } from '../client/socket'
import { IWitnessServerSocket, Logger, RPCEvent, RPCHandler } from '../types'
import { generateSessionId, WitnessError } from '../utils'
import { getInitialMessagesFromQuery } from './utils/generics'
import { HANDLERS } from './handlers'

export class WitnessServerSocket extends WitnessSocket implements IWitnessServerSocket {

	tunnels: IWitnessServerSocket['tunnels'] = {}

	private constructor(socket: WS, public sessionId: number, logger: Logger) {
		// @ts-ignore
		super(socket, {}, logger)
		// handle RPC requests
		this.addEventListener('rpc-request', handleRpcRequest.bind(this))
		// forward packets to the appropriate tunnel
		this.addEventListener('tunnel-message', handleTunnelMessage.bind(this))
		// close all tunnels when the connection is terminated
		// since this tunnel can no longer be written to
		this.addEventListener('connection-terminated', () => {
			for(const tunnelId in this.tunnels) {
				const tunnel = this.tunnels[tunnelId]
				tunnel.close(new Error('WS session terminated'))
			}
		})
	}

	getTunnel(tunnelId: number) {
		const tunnel = this.tunnels[tunnelId]
		if(!tunnel) {
			throw new WitnessError(
				'WITNESS_ERROR_NOT_FOUND',
				`Tunnel "${tunnelId}" not found`
			)
		}

		return tunnel
	}

	static async acceptConnection(
		socket: WS,
		req: IncomingMessage,
		logger: Logger
	) {
		// promisify ws.send -- so the sendMessage method correctly
		// awaits the send operation
		const bindSend = socket.send.bind(socket)
		socket.send = promisify(bindSend)

		const sessionId = generateSessionId()
		logger = logger.child({ sessionId })

		const client = new WitnessServerSocket(socket, sessionId, logger)
		try {
			const initMsgs = getInitialMessagesFromQuery(req)
			logger.trace(
				{ initMsgs: initMsgs.length },
				'new connection, validating...'
			)
			for(const msg of initMsgs) {
				await handleMessage.call(client, msg)
			}

			logger.debug('connection accepted')
		} catch(err) {
			logger.error({ err }, 'error in new connection')
			if(client.isOpen) {
				client.terminateConnection(
					err instanceof WitnessError
						? err
						: WitnessError.badRequest(err.message)
				)
			}

			return
		}

		return client
	}
}

async function handleTunnelMessage(
	this: IWitnessServerSocket,
	{ data: { tunnelId, message } }: RPCEvent<'tunnel-message'>
) {
	try {
		const tunnel = this.getTunnel(tunnelId)
		await tunnel.write(message)
	} catch(err) {
		this.logger?.error(
			{
				err,
				tunnelId,
			},
			'error writing to tunnel'
		)
	}
}

async function handleRpcRequest(
	this: IWitnessServerSocket,
	{ data: { data, requestId, respond, type } }: RPCEvent<'rpc-request'>
) {
	const logger = this.logger.child({
		rpc: type,
		requestId
	})
	try {
		logger.debug({ data }, 'handling RPC request')

		const handler = HANDLERS[type] as RPCHandler<typeof type>
		const res = await handler(data, { client: this, logger })
		await respond(res)

		logger.debug({ res }, 'handled RPC request')
	} catch(err) {
		logger.error({ err }, 'error in RPC request')
		respond(WitnessError.fromError(err))
	}
}