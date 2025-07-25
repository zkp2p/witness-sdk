# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Development Commands

### Building and Development
- `npm run build` - Compile TypeScript to JavaScript with path aliases
- `npm run build:browser` - Build browser bundle with webpack
- `npm start` - Start the attestor server (from compiled JS)
- `npm run start:tsc` - Start the attestor server with TypeScript directly

### Testing
- `npm test` - Run all tests with Jest
- `npm run test:avs` - Run AVS-specific tests only
- To run a single test file: `npm test -- src/tests/test.claim-creation.ts`
- To run tests matching a pattern: `npm test -- --testNamePattern="should create a claim"`

### Code Quality
- `npm run lint` - Run ESLint to check code style
- `npm run lint:fix` - Auto-fix ESLint issues
- **Important**: This project uses strict ESLint rules including no relative imports. Always use absolute imports starting with `src/`

### Prerequisites for Development
- `npm run download:zk-files` - Download required ZK circuit files (required for NodeJS environments)
- `npm run generate:proto` - Regenerate Protocol Buffer definitions
- `npm run generate:provider-types` - Generate TypeScript types for providers

### AVS (Eigen Layer) Commands
- `npm run build-contracts` - Build smart contracts with Forge
- `npm run deploy:contracts` - Deploy contracts to local Anvil chain
- `npm run register:avs-operator` - Register as an AVS operator
- `npm run start:chain` - Start local Anvil chain with deployed contracts

## Architecture Overview

This repository implements the Reclaim Protocol - a system for creating verifiable claims about off-chain data using TLS properties and zero-knowledge proofs.

### Core Components

1. **Attestor Server** (`src/server/`)
   - TLS proxy server that witnesses client-server communications
   - Signs attestations of data exchanged over TLS
   - Can be run standalone or as part of an Eigen AVS network

2. **Client SDK** (`src/client/`)
   - Creates claims by communicating through attestors
   - Generates zero-knowledge proofs for selective disclosure
   - Supports NodeJS, browser, and React Native (via RPC)

3. **Providers** (`src/providers/`)
   - Modular system for defining how to extract data from different services
   - HTTP provider implementation for REST APIs
   - Provider definitions use JSON schema for validation

4. **AVS Integration** (`src/avs/`)
   - Eigen Layer AVS for decentralized attestor operations
   - Smart contracts for operator management
   - Economic security through staking

5. **Window RPC** (`src/window-rpc/`)
   - Browser-based RPC server for React Native integration
   - Allows mobile apps to use the SDK via webview

### Key Technical Details

- **Cryptography**: Uses @reclaimprotocol/zk-symmetric-crypto for ZK proofs
- **TLS Handling**: Custom TLS library (@reclaimprotocol/tls) for protocol-level operations
- **Protocol Buffers**: All network messages use protobuf for efficiency
- **TypeScript**: Strict null checks enabled, no relative imports allowed
- **Testing**: Jest with SWC for fast transpilation

### Important Patterns

1. **No Relative Imports**: All imports must use absolute paths starting with `src/`
2. **Protocol Buffers**: Network messages defined in `proto/` directory
3. **Type Safety**: Provider schemas validated with AJV
4. **Error Handling**: Comprehensive error types in `src/types/errors.ts`

### Security Considerations

- Never expose private keys or secrets in code
- TLS certificate validation is critical
- Zero-knowledge proofs ensure selective disclosure
- Attestor signatures provide cryptographic guarantees

## Working with Providers

Providers define how to extract data from external services. See `src/providers/http/` for the HTTP provider implementation. Provider definitions include:
- URL patterns and request templates
- Response parsing with JSONPath
- Zero-knowledge proof parameters
- Validation schemas

## Deployment

For production deployment:
1. Use the Docker image (`attestor.dockerfile`)
2. Set required environment variables (see `.env.sample`)
3. Configure TLS certificates in `cert/` directory
4. Run with appropriate resource limits