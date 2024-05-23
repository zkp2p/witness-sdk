import { WebSocketServer } from 'ws'
import { CreateTunnelRequest } from '../proto/api'
import { logger } from '../utils'
import { makeReclaimClient, makeRpcTcpTunnel, makeRpcTlsTunnel } from '../v2'
import { makeWsServer } from '../v2/server'
import { createMockServer } from './mock-provider-server'
import { getRandomPort, randomPrivateKey } from './utils'

describe('Tunnel', () => {

	let wsServer: WebSocketServer
	let wsServerUrl: string

	let privateKeyHex: string
	let client: WebSocket

	const mockHttpsServer = createMockServer(1234)

	beforeAll(async() => {
		const wsServerPort = getRandomPort()
		wsServer = await makeWsServer(wsServerPort)
		wsServerUrl = `ws://localhost:${wsServerPort}`
	})

	afterAll(() => {
		wsServer.close()
		mockHttpsServer.server.close()
	})

	beforeEach(async() => {
		privateKeyHex = randomPrivateKey()
		client = makeReclaimClient({
			privateKeyHex,
			logger: logger.child({ client: 1 }),
			url: wsServerUrl
		})
		await client.waitForInit()
	})

	afterEach(() => {
		client.close()
	})

	it('should connect to a server via RPC tunnel', async() => {
		const tunnel = await makeRpcTcpTunnel({
			request: {
				id: 1,
				host: 'localhost',
				port: 1234,
			},
			client,
			logger,
		})

		const ws = getClientWSOnServer()
		expect(ws?.tunnels[1]).toBeTruthy()

		await tunnel.close()
	})

	it('should do a TLS handshake via RPC tunnel', async() => {
		const ws = getClientWSOnServer()

		let createReq: CreateTunnelRequest | undefined
		ws?.addEventListener('rpc-request', ({ data }) => {
			if(data.type !== 'createTunnelRequest') {
				return
			}

			createReq = data.data as CreateTunnelRequest
		})

		const tunnel = await makeRpcTlsTunnel({
			request: {
				id: 1,
				host: 'localhost',
				port: 1234,
			},
			tlsOpts: {
				verifyServerCertificate: false,
			},
			client,
			logger,
		})

		expect(ws?.tunnels[1]).toBeTruthy()
		// ensure that the client hello message
		// was sent to the server via the createTunnelRequest
		// -- which saves us a round trip
		expect(createReq?.initialMessage).toBeTruthy()

		await tunnel.close()
	})

	function getClientWSOnServer() {
		const serverSockets = [
			...wsServer.clients.values()
		] as unknown as WebSocket[]
		return serverSockets.find(s => (
			s.metadata.userId === client.metadata.userId
		))
	}
})