import { concatenateUint8Arrays, strToUint8Array, TLSConnectionOptions } from '@reclaimprotocol/tls'
import { utils } from 'ethers'
import { base64 } from 'ethers/lib/utils'
import { DEFAULT_HTTPS_PORT, RECLAIM_USER_AGENT } from 'src/config'
import {
	buildHeaders,
	convertResponsePosToAbsolutePos,
	extractHTMLElementsIndexes,
	extractJSONValueIndexes, getRedactionsForChunkHeaders,
	makeRegex,
	matchRedactedStrings,
	parseHttpResponse,
} from 'src/providers/http/utils'
import { ArraySlice, Provider, ProviderParams, ProviderSecretParams } from 'src/types'
import {
	findIndexInUint8Array,
	getHttpRequestDataFromTranscript, logger,
	REDACTION_CHAR_CODE,
	uint8ArrayToBinaryStr,
	uint8ArrayToStr,
} from 'src/utils'

const OK_HTTP_HEADER = 'HTTP/1.1 200'
const dateHeaderRegex = '[dD]ate: ((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?:[0-3][0-9]) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:[0-9]{4}) (?:[01][0-9]|2[0-3])(?::[0-5][0-9]){2} GMT)'
const dateDiff = 1000 * 60 * 10 // allow 10 min difference
type HTTPProviderParams = ProviderParams<'http'>

const HTTP_PROVIDER: Provider<'http'> = {
	hostPort: getHostPort,
	writeRedactionMode(params) {
		return ('writeRedactionMode' in params)
			? params.writeRedactionMode
			: undefined
	},
	geoLocation(params) {
		return ('geoLocation' in params)
			? getGeoLocation(params)
			: undefined
	},
	additionalClientOptions(params): TLSConnectionOptions {
		let defaultOptions: TLSConnectionOptions = {
			applicationLayerProtocols : ['http/1.1']
		}
		if('additionalClientOptions' in params) {
			defaultOptions = {
				...defaultOptions,
				...params.additionalClientOptions
			}
		}

		return defaultOptions
	},
	createRequest(secretParams, params) {
		if(
			!secretParams.cookieStr &&
            !secretParams.authorisationHeader &&
            !secretParams.headers
		) {
			throw new Error('auth parameters are not set')
		}

		const pubHeaders = params.headers || {}
		const secHeaders = { ...secretParams.headers }
		if(secretParams.cookieStr) {
			secHeaders['Cookie'] = secretParams.cookieStr
		}

		if(secretParams.authorisationHeader) {
			secHeaders['Authorization'] = secretParams.authorisationHeader
		}

		const hasUserAgent = Object.keys(pubHeaders)
			.some(k => k.toLowerCase() === 'user-agent') ||
            Object.keys(secHeaders)
            	.some(k => k.toLowerCase() === 'user-agent')
		if(!hasUserAgent) {
			//only set user-agent if not set by provider
			pubHeaders['User-Agent'] = RECLAIM_USER_AGENT
		}

		const newParams = substituteParamValues(params, secretParams)
		params = newParams.newParams

		const url = new URL(params.url)
		const { pathname } = url
		const searchParams = params.url.includes('?') ? params.url.split('?')[1] : ''
		logger.info({ url: params.url, path: pathname, query: searchParams.toString() })
		const body =
            params.body instanceof Uint8Array
            	? params.body
            	: strToUint8Array(params.body || '')
		const contentLength = body.length
		const reqLine = `${params.method} ${pathname}${searchParams?.length ? '?' + searchParams : ''} HTTP/1.1`
		const secHeadersList = buildHeaders(secHeaders)
		logger.info({ requestLine: reqLine })
		const httpReqHeaderStr = [
			reqLine,
			`Host: ${getHostHeaderString(url)}`,
			`Content-Length: ${contentLength}`,
			'Connection: close',
			//no compression
			'Accept-Encoding: identity',
			...buildHeaders(pubHeaders),
			...secHeadersList,
			'\r\n',
		].join('\r\n')
		const headerStr = strToUint8Array(httpReqHeaderStr)
		const data = concatenateUint8Arrays([headerStr, body])

		// hide all secret headers
		const secHeadersStr = secHeadersList.join('\r\n')
		const tokenStartIndex = findIndexInUint8Array(
			data,
			strToUint8Array(secHeadersStr)
		)

		const redactions = [
			{
				fromIndex: tokenStartIndex,
				toIndex: tokenStartIndex + secHeadersStr.length,
			}
		]

		if(newParams.hiddenBodyParts?.length > 0) {
			for(const hiddenBodyPart of newParams.hiddenBodyParts) {
				if(hiddenBodyPart.length) {
					redactions.push({
						fromIndex: headerStr.length + hiddenBodyPart.index,
						toIndex: headerStr.length + hiddenBodyPart.index + hiddenBodyPart.length,
					})
				}
			}
		}

		return {
			data,
			redactions: redactions,
		}
	},
	getResponseRedactions(response, rawParams) {
		logger.debug({ response:base64.encode(response), params:rawParams })

		const res = parseHttpResponse(response)
		if(!rawParams.responseRedactions?.length) {
			return []
		}

		if(((res.statusCode / 100) >> 0) !== 2) {
			logger.error({ response:base64.encode(response), params:rawParams })
			throw new Error(`Provider returned ${res.statusCode} ${res.statusMessage} error`)
		}

		const newParams = substituteParamValues(rawParams, undefined, true)
		const params = newParams.newParams

		const headerEndIndex = res.statusLineEndIndex!
		const bodyStartIdx = res.bodyStartIndex ?? 0
		if(bodyStartIdx < 4) {
			logger.error({ response: uint8ArrayToBinaryStr(response) })
			throw new Error('Failed to find response body')
		}

		const reveals: ArraySlice[] = [{ fromIndex: 0, toIndex: headerEndIndex }]

		//reveal date header
		if(res.headerIndices['date']) {
			reveals.push(res.headerIndices['date'])
		}

		const body = uint8ArrayToBinaryStr(res.body)
		const redactions: ArraySlice[] = []
		for(const rs of params.responseRedactions || []) {
			let element = body
			let elementIdx = 0
			let elementLength = -1

			if(rs.xPath) {
				const indexes = extractHTMLElementsIndexes(body, rs.xPath, !!rs.jsonPath)
				for(const { start, end } of indexes) {
					element = body.slice(start, end)
					elementIdx = start
					elementLength = end - start
					if(rs.jsonPath) {
						processJsonPath()
					} else if(rs.regex) {
						processRegexp()
					} else {
						addRedaction()
					}
				}
			} else if(rs.jsonPath) {
				processJsonPath()
				if(rs.regex) {
					processRegexp()
				} else {
					addRedaction()
				}
			} else if(rs.regex) {
				processRegexp()
			}


			function processJsonPath() {
				const jsonPathIndexes = extractJSONValueIndexes(element, rs.jsonPath!)
				// eslint-disable-next-line max-depth
				const eIndex = elementIdx
				for(const ji of jsonPathIndexes) {
					const jStart = ji.start
					const jEnd = ji.end
					element = body.slice(eIndex + jStart, eIndex + jEnd)
					elementIdx = eIndex + jStart
					elementLength = jEnd - jStart
					// eslint-disable-next-line max-depth
					if(rs.regex) {
						processRegexp()
					} else {
						addRedaction()
					}
				}
			}

			function processRegexp() {
				const regexp = makeRegex(rs.regex!)
				const elem = element || body
				const match = regexp.exec(elem)
				// eslint-disable-next-line max-depth
				if(!match?.[0]) {
					logger.error({ response: uint8ArrayToBinaryStr(res.body) })
					throw new Error(
						`regexp ${rs.regex} does not match found element '${elem}'`
					)
				}

				elementIdx += match.index
				elementLength = regexp.lastIndex - match.index
				element = match[0]
				addRedaction()
			}

			// eslint-disable-next-line unicorn/consistent-function-scoping
			function addRedaction() {
				if(elementIdx >= 0 && elementLength > 0) {
					const from = convertResponsePosToAbsolutePos(
						elementIdx,
						bodyStartIdx,
						res.chunks
					)
					const to = convertResponsePosToAbsolutePos(
						elementIdx + elementLength,
						bodyStartIdx,
						res.chunks
					)
					reveals.push({ fromIndex: from, toIndex: to })
					redactions.push(...getRedactionsForChunkHeaders(from, to, res.chunks))
				}
			}
		}

		reveals.sort((a, b) => {
			return a.toIndex - b.toIndex
		})


		if(reveals.length > 1) {
			let currentIndex = 0
			for(const r of reveals) {
				if(currentIndex < r.fromIndex) {
					redactions.push({ fromIndex: currentIndex, toIndex: r.fromIndex })
				}

				currentIndex = r.toIndex
			}

			redactions.push({ fromIndex: currentIndex, toIndex: response.length })
		}


		redactions.sort((a, b) => {
			return a.toIndex - b.toIndex
		})

		return redactions
	},
	assertValidProviderReceipt(receipt, paramsAny) {
		logTranscript()
		let extractedParams: { [_: string]: string } = {}
		const secretParams = ('secretParams' in paramsAny) ? paramsAny.secretParams as ProviderSecretParams<'http'> : undefined
		const newParams = substituteParamValues(paramsAny, secretParams, !secretParams)
		const params = newParams.newParams
		extractedParams = { ...extractedParams, ...newParams.extractedValues }

		const req = getHttpRequestDataFromTranscript(receipt)
		if(req.method !== params.method.toLowerCase()) {
			throw new Error(`Invalid method: ${req.method}`)
		}

		const url = new URL(params.url)
		const { protocol, pathname } = url

		if(protocol !== 'https:') {
			logger.error('params URL: %s', params.url)
			throw new Error(`Expected protocol: https, found: ${protocol}`)
		}

		const searchParams = params.url.includes('?') ? params.url.split('?')[1] : ''
		const expectedPath = pathname + (searchParams?.length ? '?' + searchParams : '')
		if(req.url !== expectedPath) {
			logger.error('params URL: %s', params.url)
			throw new Error(`Expected path: ${expectedPath}, found: ${req.url}`)
		}

		const expectedHostStr = getHostHeaderString(url)
		if(req.headers.host !== expectedHostStr) {
			throw new Error(`Expected host: ${expectedHostStr}, found: ${req.headers.host}`)
		}

		const connectionHeader = req.headers['connection']
		if(connectionHeader !== 'close') {
			throw new Error(`Connection header must be "close", got "${connectionHeader}"`)
		}

		const serverBlocks = receipt
			.filter(s => s.sender === 'server')
			.map((r) => r.message)
			.filter(b => !b.every(b => b === REDACTION_CHAR_CODE)) // filter out fully redacted blocks
		const response = concatArrays(...serverBlocks)

		let res: string
		let bodyStart = OK_HTTP_HEADER.length
		res = uint8ArrayToStr(response)
		if(!res.startsWith(OK_HTTP_HEADER)) {
			const statusRegex = makeRegex('^HTTP\\/1.1 (\\d{3})')
			const matchRes = statusRegex.exec(res)
			if(matchRes && matchRes.length > 1) {
				throw new Error(
					`Provider returned error ${matchRes[1]}"`
				)
			}

			let lineEnd = res.indexOf('*')
			if(lineEnd === -1) {
				lineEnd = res.indexOf('\n')
			}

			if(lineEnd === -1) {
				lineEnd = OK_HTTP_HEADER.length
			}

			throw new Error(
				`Response did not start with "${OK_HTTP_HEADER}" got "${res.slice(0, lineEnd)}"`
			)
		}


		//validate server Date header if present
		const dateHeader = makeRegex(dateHeaderRegex).exec(res)
		if(dateHeader?.length > 1) {
			const serverDate = Date.parse(dateHeader[1])
			if((Date.now() - serverDate) > dateDiff) {

				logger.info({ dateHeader:dateHeader[0], current: Date.now() }, 'date header is off')

				throw new Error(
					`Server date is off by "${(Date.now() - serverDate) / 1000} s"`
				)
			}

			bodyStart = dateHeader.index + dateHeader[0].length
		}


		const paramBody = params.body instanceof Uint8Array
			? params.body
			: strToUint8Array(params.body || '')

		if(paramBody.length > 0 && !matchRedactedStrings(paramBody, req.body)) {
			throw new Error('request body mismatch')
		}

		//remove asterisks to account for chunks in the middle of revealed strings
		if(!secretParams) {
			res = res.slice(bodyStart).replace(/(\*){3,}/g, '')
		}


		for(const { type, value, invert, hash } of params.responseMatches || []) {
			const inv = Boolean(invert) // explicitly cast to boolean

			switch (type) {
			case 'regex':
				const regexRes = makeRegex(value).exec(res)
				const match = regexRes !== null
				if(match === inv) { // if both true or both false then fail
					throw new Error(
						'Invalid receipt.'
						+ ` Regex "${value}" ${invert ? 'matched' : "didn't match"}`
					)
				}

				if(!match) {
					continue
				}

				const groups = regexRes?.groups
				for(const paramName in groups || []) {
					if(paramName in extractedParams) {
						throw new Error(`Duplicate parameter ${paramName}`)
					}

					if(hash) {
						extractedParams[paramName] = utils.keccak256(
							strToUint8Array(groups[paramName])
						).toLowerCase()
					} else {
						extractedParams[paramName] = groups[paramName]
					}
				}

				break
			case 'contains':
				const includes = res.includes(value)
				if(includes === inv) {
					throw new Error(
						`Invalid receipt. Response ${invert ? 'contains' : 'does not contain'} "${value}"`
					)
				}

				break
			default:
				throw new Error(`Invalid response match type ${type}`)
			}
		}

		function concatArrays(...bufs: Uint8Array[]) {
			const totalSize = bufs.reduce((acc, e) => acc + e.length, 0)
			const merged = new Uint8Array(totalSize)

			let lenDone = 0
			for(const array of bufs) {
				merged.set(array, lenDone)
				lenDone += array.length
			}

			return merged

		}

		return { extractedParameters: extractedParams }

		function logTranscript() {
			const clientMsgs = receipt.filter(s => s.sender === 'client').map(m => m.message)
			const serverMsgs = receipt.filter(s => s.sender === 'server').map(m => m.message)

			const clientTranscript = base64.encode(concatenateUint8Arrays(clientMsgs))
			const serverTranscript = base64.encode(concatenateUint8Arrays(serverMsgs))

			logger.debug({ request: clientTranscript, response:serverTranscript, params:paramsAny })
		}
	},
}


function getHostPort(params: ProviderParams<'http'>) {
	const { host } = new URL(getURL(params))
	if(!host) {
		throw new Error('url is incorrect')
	}

	return host
}

/**
 * Obtain the host header string from the URL.
 * https://stackoverflow.com/a/3364396
 */
function getHostHeaderString(url: URL) {
	const host = url.hostname
	const port = url.port
	return port && +port !== DEFAULT_HTTPS_PORT
		? `${host}:${port}`
		: host

}

type ReplacedParams = {
    newParam: string
    extractedValues: { [_: string]: string }
    hiddenParts: { index: number, length: number } []
} | null

const paramsRegex = /\{\{([^{}]+)}}/sgi

function substituteParamValues(
	currentParams: HTTPProviderParams,
	secretParams?: ProviderSecretParams<'http'>,
	ignoreMissingBodyParams?: boolean
): {
    newParams: HTTPProviderParams
    extractedValues: { [_: string]: string }
    hiddenBodyParts: { index: number, length: number } []
} {

	const params = JSON.parse(JSON.stringify(currentParams))
	let extractedValues: { [_: string]: string } = {}


	const urlParams = extractAndReplaceTemplateValues(params.url)
	if(urlParams) {
		params.url = urlParams.newParam
		extractedValues = { ...urlParams.extractedValues }
	}


	let bodyParams: ReplacedParams
	let hiddenBodyParts: { index: number, length: number } [] = []
	if(params.body) {
		const strBody = typeof params.body === 'string' ? params.body : uint8ArrayToStr(params.body)
		bodyParams = extractAndReplaceTemplateValues(strBody, ignoreMissingBodyParams)
		if(bodyParams) {
			params.body = bodyParams.newParam
			extractedValues = { ...extractedValues, ...bodyParams.extractedValues }
			hiddenBodyParts = bodyParams.hiddenParts
		}

	}

	const geoParams = extractAndReplaceTemplateValues(params.geoLocation)
	if(geoParams) {
		params.geoLocation = geoParams.newParam
		extractedValues = { ...extractedValues, ...geoParams.extractedValues }
	}

	if(params.responseRedactions) {
		for(const r of params.responseRedactions) {
			if(r.regex) {
				const regexParams = extractAndReplaceTemplateValues(r.regex)
				r.regex = regexParams?.newParam
			}

			if(r.xPath) {
				const xpathParams = extractAndReplaceTemplateValues(r.xPath)
				r.xPath = xpathParams?.newParam
			}

			if(r.jsonPath) {
				const jsonPathParams = extractAndReplaceTemplateValues(r.jsonPath)
				r.jsonPath = jsonPathParams?.newParam
			}
		}
	}

	if(params.responseMatches) {
		for(const r of params.responseMatches) {
			if(r.value !== '') {
				const matchParam = extractAndReplaceTemplateValues(r.value)
				r.value = matchParam?.newParam!
				extractedValues = { ...extractedValues, ...matchParam?.extractedValues }
			}
		}
	}

	return {
		newParams: params,
		extractedValues: extractedValues,
		hiddenBodyParts: hiddenBodyParts
	}

	function extractAndReplaceTemplateValues(param: string | undefined, ignoreMissingParams?: boolean): ReplacedParams {

		if(!param) {
			return null
		}

		//const paramNames: Set<string> = new Set()
		const extractedValues: { [_: string]: string } = {}
		const hiddenParts: { index: number, length: number }[] = []


		let totalOffset = 0
		param = param.replace(paramsRegex, (match, pn, offset) => {
			if(params.paramValues && pn in params.paramValues) {
				extractedValues[pn] = params.paramValues[pn]
				totalOffset += params.paramValues[pn].length - match.length
				return params.paramValues[pn]
			} else if(secretParams) {
				if(secretParams?.paramValues && pn in secretParams?.paramValues) {
					hiddenParts.push({
						index: offset + totalOffset,
						length: secretParams.paramValues[pn].length,
					})
					totalOffset += secretParams.paramValues[pn].length - match.length
					return secretParams.paramValues[pn]
				} else {
					throw new Error(`parameter's "${pn}" value not found in paramValues and secret parameter's paramValues`)
				}
			} else {
				if(!(!!ignoreMissingParams)) {
					throw new Error(`parameter's "${pn}" value not found in paramValues`)
				} else {
					return match
				}
			}
		})

		return {
			newParam: param,
			extractedValues: extractedValues,
			hiddenParts: hiddenParts
		}
	}
}

function getGeoLocation(v2Params: HTTPProviderParams) {
	if(v2Params?.geoLocation) {
		const paramNames: Set<string> = new Set()
		let geo = v2Params.geoLocation
		//extract param names

		let match: RegExpExecArray | null = null
		while(match = paramsRegex.exec(geo)) {
			paramNames.add(match[1])
		}

		for(const pn of paramNames) {
			if(v2Params.paramValues && pn in v2Params.paramValues) {
				geo = geo?.replaceAll(`{{${pn}}}`, v2Params.paramValues[pn].toString())
			} else {
				throw new Error(`parameter "${pn}" value not found in templateParams`)
			}
		}

		return geo
	}

	return undefined
}

function getURL(v2Params: HTTPProviderParams) {
	let hostPort = v2Params?.url
	const paramNames: Set<string> = new Set()

	//extract param names
	let match: RegExpExecArray | null = null
	while(match = paramsRegex.exec(hostPort)) {
		paramNames.add(match[1])
	}

	for(const pn of paramNames) {
		if(v2Params.paramValues && pn in v2Params.paramValues) {
			hostPort = hostPort?.replaceAll(`{{${pn}}}`, v2Params.paramValues[pn].toString())
		} else {
			throw new Error(`parameter "${pn}" value not found in templateParams`)
		}
	}

	return hostPort
}


export default HTTP_PROVIDER
