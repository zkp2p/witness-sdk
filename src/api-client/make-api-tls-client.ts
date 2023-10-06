import { detectEnvironment } from '@reclaimprotocol/common-grpc-web-transport'
import { makeTLSClient, PACKET_TYPE, SUPPORTED_CIPHER_SUITE_MAP, SUPPORTED_NAMED_CURVES, TLSConnectionOptions, TLSPresharedKey, TLSSessionTicket } from '@reclaimprotocol/tls'
import { InitialiseSessionRequest, PullFromSessionResponse, PushToSessionRequest, ReclaimWitnessClient, TranscriptMessageSenderType, WitnessVersion } from '../proto/api'
import { ArraySlice, CompleteTLSPacket, Logger } from '../types'
import { getBlocksToReveal, logger as MAIN_LOGGER, PrepareZKProofsBaseOpts, redactSlices } from '../utils'
import { preparePacketsForReveal } from '../utils/prepare-packets'

export type BaseAPIClientOptions = {
	client: ReclaimWitnessClient
	logger?: Logger
	additionalConnectOpts?: TLSConnectionOptions
	requestData?: Partial<InitialiseSessionRequest>
	/**
	 * Default way to redact data sent from the client to the server.
	 * For TLS1.3, this is 'key-update', for TLS1.2, this is 'zk'
	 *
	 * Note: TLS1.2 does not support key update method, zk is
	 * the only way to redact data
	 *
	 * @default 'key-update'
	 */
	defaultWriteRedactionMode?: 'key-update' | 'zk'
} & PrepareZKProofsBaseOpts

export type APITLSClientOptions = BaseAPIClientOptions & {
	host: string
	port: number
	handleDataFromServer(data: Uint8Array): void
	onTlsEnd?(error?: Error): void
	/** return the sections of the response to redact */
	redactResponse?(data: Uint8Array): ArraySlice[]
}

type ServerBlock = { plaintext: Uint8Array, index: number }

// we only support chacha20-poly1305 for API sessions
// that need ZK proofs
const ZK_CIPHER_SUITES: (keyof typeof SUPPORTED_CIPHER_SUITE_MAP)[]
	= [
		'TLS_CHACHA20_POLY1305_SHA256',
		'TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256',
		'TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256',
	]

const NAMED_CURVE_LIST = detectEnvironment() === 'node'
	? SUPPORTED_NAMED_CURVES
	// X25519 is not supported in the browser
	: SUPPORTED_NAMED_CURVES.filter(c => c !== 'X25519')

export const makeAPITLSClient = ({
	host,
	port,
	client,
	redactResponse,
	handleDataFromServer,
	onTlsEnd,
	requestData,
	logger: _logger,
	additionalConnectOpts,
	zkOperator,
	zkProofConcurrency,
	defaultWriteRedactionMode = 'key-update'
}: APITLSClientOptions) => {
	let sessionId: string | undefined
	let pullFromSessionAbort: AbortController | undefined
	let psk: TLSPresharedKey | undefined
	let metadata: ReturnType<typeof tls.getMetadata>

	const logger = _logger || MAIN_LOGGER?.child({ })
	const enableResponseRedaction = !!redactResponse
	const { generateOutOfBandSession } = additionalConnectOpts || {}

	const allBlocks: CompleteTLSPacket[] = []
	const cipherSuites = enableResponseRedaction
		? ZK_CIPHER_SUITES
		: undefined

	if(!enableResponseRedaction) {
		logger.info('disabled ZK proofs')
	}

	let onHandshake: (() => void) | undefined
	const tls = makeTLSClient({
		host,
		logger,
		cipherSuites,
		namedCurves: NAMED_CURVE_LIST,
		...additionalConnectOpts || {},
		onHandshake() {
			metadata = tls.getMetadata()
			onHandshake?.()
		},
		onRead(packet, ctx) {
			allBlocks.push({
				packet,
				ctx,
				sender: TranscriptMessageSenderType
					.TRANSCRIPT_MESSAGE_SENDER_TYPE_SERVER,
				index: -1,
			})
		},
		onApplicationData(plaintext) {
			return handleDataFromServer(plaintext)
		},
		onTlsEnd,
		async write(packet, ctx) {
			if(!sessionId) {
				throw new Error('Too early to write')
			}

			const req: PushToSessionRequest = {
				sessionId,
				message: {
					recordHeader: packet.header,
					content: packet.content,
				}
			}
			const res = await client.pushToSession(req)

			const completePkt: CompleteTLSPacket = {
				packet,
				ctx,
				sender: TranscriptMessageSenderType
					.TRANSCRIPT_MESSAGE_SENDER_TYPE_CLIENT,
				index: res.index,
			}
			allBlocks.push(completePkt)

			if(
				// reveal all handshake msgs
				// from the client -- so witness knows
				// there was no sneaky business
				ctx.type === 'ciphertext'
				&& (
					ctx.contentType === 'HANDSHAKE'
					|| packet.header[0] !== PACKET_TYPE.WRAPPED_RECORD
				)
			) {
				completePkt.reveal = { type: 'complete' }
			}

			logger.debug(
				{
					sessionId,
					length: packet.content.length
				},
				'pushed data'
			)
		}
	})

	return {
		generatePSK,
		async connect() {
			if(!psk && generateOutOfBandSession) {
				await generatePSK()
			}

			let initialiseSessionParams = requestData
			if(
				!initialiseSessionParams?.beaconBasedProviderClaimRequest
				&& !initialiseSessionParams?.receiptGenerationRequest
			) {
				initialiseSessionParams = {
					receiptGenerationRequest: { host, port },
					beaconBasedProviderClaimRequest: undefined
				}
			}

			logger.trace('initialising...')

			const res = await client.initialiseSession(initialiseSessionParams)
			sessionId = res.sessionId
			pullFromSessionAbort = new AbortController()

			logger.debug({ sessionId }, 'initialised session')

			const pullResult = await client.pullFromSession(
				{
					sessionId,
					version: WitnessVersion.WITNESS_VERSION_1_0_0
				},
				{ signal: pullFromSessionAbort?.signal }
			)

			logger.debug('pulling from session')

			const evPromise = listenToDataFromServer(
				pullResult,
				() => {
					logger.debug('session ready')
					tls.startHandshake({ psk })
				}
			)

			await Promise.race([
				evPromise,
				new Promise<void>(resolve => {
					onHandshake = resolve
				})
			])

			if(!tls.isHandshakeDone()) {
				throw new Error('Handshake failed')
			}

			logger.debug({ metadata }, 'handshake done')

			return () => {
				pullFromSessionAbort?.abort()
			}
		},
		async cancel() {
			if(!sessionId) {
				throw new Error('Nothing to cancel')
			}

			pullFromSessionAbort?.abort()
			await client.cancelSession({ sessionId })

			await tls.end()
		},
		async finish() {
			if(!sessionId) {
				throw new Error('Nothing to cancel')
			}

			let serverBlocksToReveal: ReturnType<typeof getBlocksToReveal<ServerBlock>> = 'all'
			if(redactResponse && enableResponseRedaction) {
				const serverBlocks: ServerBlock[] = []
				for(let i = 0;i < allBlocks.length;i++) {
					const b = allBlocks[i]
					if(
						b.sender === TranscriptMessageSenderType.TRANSCRIPT_MESSAGE_SENDER_TYPE_SERVER
						&& b.ctx.type === 'ciphertext'
						&& b.ctx.contentType === 'APPLICATION_DATA'
					) {
						serverBlocks.push({
							plaintext: b.ctx.plaintext,
							index: i,
						})
					}
				}

				serverBlocksToReveal = getBlocksToReveal(
					serverBlocks,
					redactResponse
				)
			}

			if(serverBlocksToReveal === 'all') {
				// reveal all server side blocks
				for(const block of allBlocks) {
					if(block.sender === TranscriptMessageSenderType.TRANSCRIPT_MESSAGE_SENDER_TYPE_SERVER) {
						block.reveal = { type: 'complete' }
					}
				}
			} else {
				for(const block of serverBlocksToReveal) {
					allBlocks[block.block.index].reveal = {
						type: 'partial',
						redactedPlaintext: block.redactedPlaintext
					}
				}
			}

			const revealBlocks = await preparePacketsForReveal(
				allBlocks,
				{
					logger,
					zkOperator,
					zkProofConcurrency,
					cipherSuite: metadata.cipherSuite!,
				}
			)

			const result = await client.finaliseSession({
				sessionId,
				revealBlocks,
			})

			await tls.end()
			pullFromSessionAbort?.abort()

			return result
		},
		async write(data: Uint8Array, redactedSections: ArraySlice[]) {
			const writeRedactMode = metadata?.version === 'TLS1_2'
				? 'zk'
				: defaultWriteRedactionMode
			if(writeRedactMode === 'key-update') {
				await writeRedactedWithKeyUpdate()
			} else {
				await writeRedactedZk()
			}

			async function writeRedactedWithKeyUpdate() {
				let currentIndex = 0
				for(let i = 0;i < redactedSections.length;i++) {
					const section = redactedSections[i]
					const block = data.slice(currentIndex, section.fromIndex)
					if(block.length) {
						await writeWithReveal(block, true)
					}

					const redacted = data.slice(section.fromIndex, section.toIndex)
					await writeWithReveal(redacted, false)
					currentIndex = section.toIndex
				}

				// write if redactions were there
				const lastBlockStart = redactedSections?.[redactedSections.length - 1]?.toIndex || 0
				const block = data.slice(lastBlockStart)
				if(block.length) {
					await writeWithReveal(block, true)
				}
			}

			async function writeRedactedZk() {
				await tls.write(data)
				const lastBlock = getLastBlock(
					TranscriptMessageSenderType
						.TRANSCRIPT_MESSAGE_SENDER_TYPE_CLIENT
				)
				lastBlock!.reveal = {
					type: 'partial',
					redactedPlaintext: redactSlices(
						data,
						redactedSections
					)
				}
			}
		}
	}

	async function listenToDataFromServer(
		result: AsyncIterable<PullFromSessionResponse>,
		onReady: () => void
	) {
		try {
			for await (const { message, index } of result) {
				// empty record header means the session is ready
				if(!message?.recordHeader?.length) {
					onReady()
					continue
				}

				const type = message.recordHeader[0]
				await tls.handleReceivedPacket(type, {
					header: message.recordHeader,
					content: message.content,
				})

				const block = getLastBlock(TranscriptMessageSenderType.TRANSCRIPT_MESSAGE_SENDER_TYPE_SERVER)
				block!.index = index
			}
		} catch(error) {
			if(!error.message.includes('aborted')) {
				await tls.end(error)
				throw error
			}
		}

		logger.info('live stream ended')
		await tls.end()
	}

	async function writeWithReveal(data: Uint8Array, reveal: boolean) {
		if(!reveal) {
			await tls.updateTrafficKeys()
		}

		await tls.write(data)
		// find the last packet sent by the client
		// and mark it for reveal
		const lastPkt = getLastBlock(TranscriptMessageSenderType.TRANSCRIPT_MESSAGE_SENDER_TYPE_CLIENT)
		if(reveal) {
			lastPkt!.reveal = { type: 'complete' }
		} else {
			delete lastPkt!.reveal
		}

		if(!reveal) {
			await tls.updateTrafficKeys()
		}
	}

	async function generatePSK() {
		const { Socket } = await import('net')
		const socket = new Socket()
		let onTicket: undefined | ((ticket: TLSSessionTicket) => void)
		const tls = makeTLSClient({
			host,
			logger,
			cipherSuites,
			...additionalConnectOpts || {},
			async write({ header, content }) {
				socket.write(header)
				socket.write(content)
			},
			onSessionTicket(ticket) {
				onTicket?.(ticket)
			},
		})

		socket.once('connect', () => tls.startHandshake())
		socket.on('data', tls.handleReceivedBytes)

		socket.connect({ host, port })

		const ticket = new Promise<TLSSessionTicket>(resolve => {
			onTicket = resolve
		})

		logger.info('waiting for TLS ticket')

		psk = await tls.getPskFromTicket(await ticket)

		logger.info('got TLS ticket, ending session...')
		socket.end()
		tls.end()
	}

	function getLastBlock(sender: TranscriptMessageSenderType) {
		// set the correct index for the server blocks
		for(let i = allBlocks.length - 1;i >= 0;i--) {
			const block = allBlocks[i]
			if(block.sender === sender) {
				return block
			}
		}
	}
}