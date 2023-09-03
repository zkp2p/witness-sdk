// The zomato order count provider aims to prove the number of times you have ordered on zomato.

import { DEFAULT_PORT } from '../../config'
import { Provider } from '../../types'
import { gunzipSync } from '../../utils'
import { getCompleteHttpResponseFromTranscript, getHttpRequestHeadersFromTranscript } from '../../utils/http-parser'


// params for the request that will be publicly available
// contains the userId and orders of the logged in user
type ZomatoOrderParams = {
	orderCount: number
	userId: string
}

// params required to generate the http request to Zomato
// these would contain fields that are to be hidden from the public,
// including the witness
type ZomatoLoginSecretParams = {
	/** cookie string for authentication */
	cookieStr: string
}

// where to send the HTTP request
const HOST = 'www.zomato.com'
const HOSTPORT = `${HOST}:${DEFAULT_PORT}`


const zomatoOrders: Provider<ZomatoOrderParams, ZomatoLoginSecretParams> = {
	hostPort: HOSTPORT,
	areValidParams(params): params is ZomatoOrderParams {
		return (
			typeof params.orderCount === 'number'
			&& typeof params.userId === 'string'
		)
	},
	createRequest({ cookieStr }, params) {
		const strRequest = [
			`GET /users/${params.userId}/ordering HTTP/1.1`,
			'Host: ' + HOST,
			'Connection: closed',
			`cookie: ${cookieStr}`,
			'User-Agent: reclaim/1.0.0',
			'Accept-Encoding: gzip, deflate',
			'\r\n'
		].join('\r\n')

		// find the cookie string and redact it
		const data = Buffer.from(strRequest)
		const cookieStartIndex = data.indexOf(cookieStr)

		return {
			data,
			redactions: [
				{
					fromIndex: cookieStartIndex,
					toIndex: cookieStartIndex + cookieStr.length
				}
			]
		}
	},
	assertValidProviderReceipt(receipt, params) {
		// ensure the request was sent to the right place
		if(receipt.hostPort !== HOSTPORT) {
			throw new Error(`Invalid hostPort: ${receipt.hostPort}`)
		}

		// parse the HTTP request & check
		// the method, URL, headers, etc. match what we expect
		const req = getHttpRequestHeadersFromTranscript(receipt.transcript)
		if(req.method !== 'get') {
			throw new Error(`Invalid method: ${req.method}`)
		}

		if(!req.url.includes('ordering')) {
			throw new Error(`Invalid path: ${req.url}`)
		}

		const res = getCompleteHttpResponseFromTranscript(
			receipt.transcript
		)

		if(!res.headers['content-type']?.startsWith('text/html')) {
			throw new Error(`Invalid content-type: ${res.headers['content-type']}`)
		}

		if(res.statusCode !== 200) {
			throw new Error(`Invalid status code received: ${res.statusCode}. Expected 200`)
		}

		let html: string
		if(res.headers['content-encoding'] === 'gzip') {
			const buf = Buffer.from(res.body)
			html = gunzipSync(buf).toString()
		} else {
			html = res.body.toString()
		}

		const userRegexp = /Order History<\/h1>.*Showing \d+-\d+ of \d+ orders<\/div>/g

		const matches = html.match(userRegexp)
		const orderstring = matches?.[0]
			.match(/Showing.*orders/g)?.[0]
			.split(' ')?.at(-2)

		if(orderstring === undefined) {
			throw new Error(`Invalid order count received, expected ${params.orderCount}`)
		}

		const ordernum = parseInt(orderstring, 10)

		if(isNaN(ordernum)) {
			throw new Error(`Could not fetch number of orders, expected ${params.orderCount}`)
		}

		if(ordernum !== params.orderCount) {
			throw new Error(`Invalid order count: ${orderstring} expected, ${params.orderCount} received`)
		}

	},
}

export default zomatoOrders