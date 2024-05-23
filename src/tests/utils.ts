import { randomBytes } from 'crypto'

export function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

export function randomPrivateKey() {
	return '0x' + randomBytes(32).toString('hex')
}

export function getRandomPort() {
	return Math.floor(Math.random() * 5000 + 5000)
}