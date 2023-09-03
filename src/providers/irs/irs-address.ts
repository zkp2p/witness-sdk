/**
 * Verify the Address from IRS Profile API Endpoint
 *
 * https://sa.www4.irs.gov/ola/rest/taxpayer/accountSummary
 */
import { DEFAULT_PORT } from '../../config'
import { Provider } from '../../types'
import {
	getCompleteHttpResponseFromTranscript,
	getHttpRequestHeadersFromTranscript,
} from '../../utils/http-parser'

type IrsParams = {
  //Things that I want to verify
  address: string
};

type IrsSecretParams = {
  token: string
};

// where to send the HTTP request
const HOST = 'scrape.smartproxy.com'
const API_URL = 'https://sa.www4.irs.gov/ola/rest/taxpayer/accountSummary'
const HOSTPORT = `${HOST}:${DEFAULT_PORT}`


// what API to call
const METHOD = 'POST'
const PATH = '/v1/tasks'

const extractCookiesFromStr = (token: string) => {
	const cookies = token.split(';')
	const cookieDictArr = cookies.map(cookie => {
		const cookieVal = cookie.substring(cookie.indexOf('=') + 1)
		const cookieKey = cookie.split('=')[0]
		return { ['key']: cookieKey, ['value']: cookieVal }
	})
	return cookieDictArr
}

const irsAddress: Provider<IrsParams, IrsSecretParams> = {
	hostPort: HOSTPORT,
	areValidParams(params): params is IrsParams {
		return typeof params.address === 'string'
	},
	createRequest({ token }) {
		// this is a simple http request construction.
		// see https://developer.mozilla.org/en-US/docs/Web/HTTP/Messages

		const payloadHeaders = {
			'Accept': '*/*',
			'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
			'sec-fetch-mode': 'cors',
			'Connection': 'close',
			'user-agent': 'reclaim/1.0.0',
		}

		const payloadCookies = extractCookiesFromStr(token)

		const payload = JSON.stringify({
			'target': 'universal',
			'url': API_URL,
			'headers': payloadHeaders,
			'cookies': payloadCookies,
			'http_method': 'get'
		})

		const strRequest = [
			`${METHOD} ${PATH} HTTP/1.1`,
			`Host: ${HOST}`,
			'accept: application/json',
			'Content-Type: application/json',
			'Connection: close',
			'Authorization: Basic VTAwMDAxMTE3ODQ6cHZxZXdjSzl0cFRvM05iNTZa',
			`Content-Length: ${payload.length}`,
			'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
			`\r\n${payload}\}`
		].join('\r\n')

		// find the Token string and redact it
		const data = Buffer.from(strRequest)
		const tokenStartIndex = data.indexOf(`${payload}`)

		return {
			data,
			// anything that should be redacted from the transcript
			// should be added to this array
			redactions: [
				{
					fromIndex: tokenStartIndex,
					toIndex: tokenStartIndex + `${payload}`.length,
				},
			],
		}
	},
	assertValidProviderReceipt(receipt, { address }) {
		// ensure the request was sent to the right place
		if(receipt.hostPort !== HOSTPORT) {
			throw new Error(`Invalid hostPort: ${receipt.hostPort}`)
		}

		// parse the HTTP request & check
		// the method, URL, headers, etc. match what we expect
		const req = getHttpRequestHeadersFromTranscript(receipt.transcript)
		if(req.method !== METHOD.toLowerCase()) {
			throw new Error(`Invalid method: ${req.method}`)
		}

		if(!req.url.startsWith(PATH)) {
			throw new Error(`Invalid path: ${req.url}`)
		}

		// we ensure the connection header was sent as "close"
		// this is done to avoid any possible malicious request
		// that contains multiple requests, but via redactions
		// is spoofed as a single request
		if(req.headers['connection'] !== 'close') {
			throw new Error('Invalid connection header')
		}

		// now we parse the HTTP response & check
		// if the address returned by the API
		// matches the parameters the user provided
		const res = getCompleteHttpResponseFromTranscript(receipt.transcript)
		if(res.statusCode !== 200) {
			throw new Error(`Invalid status code: ${res.statusCode}`)
		}

		const resBody = JSON.parse(res.body.toString())
		const response = resBody.results[0].content
		try {
			const json = JSON.parse(response)
			if(!json) {
				throw new Error('No response returned from server!')
			}

			if(!('taxPayerSummary' in json)) {
				throw new Error('Invalid response returned from server!')
			}

			let parsedAddress = ''

			if(json.taxPayerSummary?.physicalAddressLine1Txt) {
				parsedAddress = parsedAddress + ' ' + json.taxPayerSummary.physicalAddressLine1Txt
			}

			if(json.taxPayerSummary?.physicalAddressCityNm) {
				parsedAddress = parsedAddress + ' ' + json.taxPayerSummary.physicalAddressCityNm
			}

			if(json.taxPayerSummary?.physicalAddressStateCd) {
				parsedAddress = parsedAddress + ' ' + json.taxPayerSummary.physicalAddressStateCd
			}

			if(json.taxPayerSummary?.physicalAddressZipCd) {
				parsedAddress = parsedAddress + ' ' + json.taxPayerSummary.physicalAddressZipCd
			}

			if(json.taxPayerSummary?.physicalAddressZipPlusFourExtensionCd) {
				parsedAddress = parsedAddress + ' ' + json.taxPayerSummary.physicalAddressZipPlusFourExtensionCd
			}

			if(parsedAddress !== address) {
				throw new Error(`Extracted address "${parsedAddress}" doesn't match with "${address}"`)
			}
		} catch(error) {
			throw new Error(error)
		}
	},
}

export default irsAddress