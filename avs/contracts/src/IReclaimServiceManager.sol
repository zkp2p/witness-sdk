// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.9;

interface IReclaimServiceManager {
    // EVENTS
    event NewTaskCreated(uint32 indexed taskIndex, Task task);

    event TaskCompleted(uint32 indexed taskIndex, CompletedTask task);

    // STRUCTS
    struct ClaimRequest {
        /**
         * Name of the provider.
         * @example "http" 
         */
        string provider;
        /**
         * keccak256 hash of the user identification
         * parameters.
         */
        bytes32 claimUserId;
        /**
         * keccak256 hash of the claim,
         * i.e. hash(provider, parameters, context)
         */
        bytes32 claimHash;
        /**
         * Address of the requester.
         */
        address owner;
    }

    struct Operator {
		/** ETH address */
		address addr;
		/** Reclaim RPC Url to connect to */
		string url;
	}

    struct Task {
        ClaimRequest request;
        uint32 createdAt;
        /**
         * unix timestamp (seconds) when the task expires.
         * No further responses will be accepted after this time.
         */
        uint32 expiresAt;
        /**
         * Minimum number of signatures required to complete the task.
         */
        uint8 minimumSignatures;
        /**
         * Operators selected for the task.
         */
        Operator[] operators;
        /**
         * Total fee paid for the task.
         */
        uint256 feePaid;
    }

	/** Claim with signatures & signer */
	struct CompletedTask {
		Task task;
		bytes[] signatures;
	}

    struct OperatorMetadata {

        address addr;
        /**
         * RPC URL for the operator
        */
        string url;
    }

    struct TaskCreationMetadata {
        /**
         * How long a task can be active for before it is considered
         * expired
         */
        uint32 maxTaskLifetimeS;
        /**
         * Minimum number of signatures required to complete the task.
         */
        uint8 minSignaturesPerTask;
    }

    // FUNCTIONS

    // update the task creation metadata
    // 0 values, empty strings are ignored -- essentially
    // all falsey values are ignored.
    function updateTaskCreationMetadata(
        TaskCreationMetadata memory metadata
    ) external;

    function whitelistAddressAsOperator(
        address operator,
        bool isWhitelisted
    ) external;

    // NOTE: this function is called by the operator
    // updating their metadata.
    // pass empty data to remove operator
    function updateOperatorMetadata(
        OperatorMetadata memory metadata
    ) external;

    // NOTE: this function creates new task.
    function createNewTask(
        ClaimRequest memory request
    ) external;

    // NOTE: this function is called by the user
    // once they have aggregated all the responses
    // to the task.
    function taskCompleted(
        CompletedTask memory completedTask,
        uint32 referenceTaskIndex
    ) external;
}