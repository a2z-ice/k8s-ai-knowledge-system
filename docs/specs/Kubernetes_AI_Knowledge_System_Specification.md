# Kubernetes AI Knowledge System -- Technical Specification

**Version:** 1.0\
**Date:** 2026-02-23\
**Author:** System Architecture Team

------------------------------------------------------------------------

# 1. Executive Summary

This document defines the architecture, design, data flow, and
implementation details of an AI-powered Kubernetes knowledge system.

The solution enables users to query Kubernetes cluster information
through an AI chat interface orchestrated by n8n. The AI retrieves
contextual knowledge from a Qdrant vector database, which is
continuously updated via a Change Data Capture (CDC) pipeline monitoring
the Kubernetes etcd datastore.

The system is composed of two primary flows:

1.  AI K8s Flow
2.  CDC (Change Data Capture) Flow

------------------------------------------------------------------------

# 2. System Architecture Overview

## 2.1 High-Level Components

-   Kubernetes Cluster (kind)
-   etcd datastore
-   CDC Streaming Pipeline (Debezium + Kafka or alternative OSS)
-   n8n orchestration engine
-   Qdrant vector database
-   Ollama (LLM + embedding model)
-   Multi-agent AI processing
-   Docker Compose environment
-   Playwright E2E testing framework

------------------------------------------------------------------------

# 3. Architecture Diagram (Logical)

User → n8n Chat Trigger → AI K8s Flow\
AI K8s Flow → Ollama LLM\
AI K8s Flow → Qdrant (Vector Search)\
CDC Flow → etcd → Kafka → Debezium → n8n → Qdrant

------------------------------------------------------------------------

# 4. AI K8s Flow Specification

## 4.1 Objective

Enable natural language querying of Kubernetes cluster state using RAG
(Retrieval Augmented Generation).

## 4.2 Functional Steps

1.  User sends query via n8n chat trigger.
2.  Query is embedded using Ollama embedding model.
3.  Vector similarity search performed in Qdrant.
4.  Retrieved documents are passed to Ollama chat model.
5.  Final structured response is generated.
6.  Response returned to user.

## 4.3 AI Requirements

-   Local Ollama chat model (high-quality reasoning model)
-   Ollama embedding model (optimized for vector retrieval)
-   Structured output formatting (tables supported)

## 4.4 Example Query Requirement

Query: "How many namespaces exist in the Kubernetes cluster and how many
resources per namespace?"

Expected Output: \| Namespace \| Resource Count \|
\|-----------\|----------------\| \| default \| 12 \| \| kube-system \|
25 \|

------------------------------------------------------------------------

# 5. CDC Flow Specification

## 5.1 Objective

Continuously monitor Kubernetes etcd datastore and synchronize changes
to Qdrant vector database.

## 5.2 Change Events to Capture

-   Insert (New resource)
-   Update (Modified resource)
-   Delete (Removed resource)

## 5.3 CDC Requirements

-   Stream-based solution
-   Near real-time propagation
-   Idempotent updates
-   No duplicate vector entries

## 5.4 Recommended Open Source Stack

Preferred: - Debezium (CDC engine) - Apache Kafka (event streaming) -
Kafka Connect - etcd connector (custom or community plugin)

Alternative: - Direct Kubernetes API Watchers (if etcd streaming is
complex) - Redpanda (Kafka-compatible lightweight alternative)

## 5.5 Deduplication Strategy

Each Kubernetes resource must store:

-   apiVersion
-   kind
-   namespace
-   name
-   uid (Primary Unique Key)

Vector DB Update Algorithm:

1.  On change event:
    -   Extract unique key
2.  Check if resource exists in Qdrant
3.  If exists → Delete existing vector
4.  Insert updated vector document

------------------------------------------------------------------------

# 6. Data Model in Qdrant

Each vector entry must contain:

-   embedding vector
-   metadata:
    -   resource_uid
    -   kind
    -   namespace
    -   name
    -   labels
    -   annotations
    -   raw_spec_json
    -   last_updated_timestamp

------------------------------------------------------------------------

# 7. Multi-Agent Architecture

## 7.1 Agent 1 -- AI Chat Agent

Responsibilities: - Accept user queries - Generate embeddings - Retrieve
context - Generate final answer

## 7.2 Agent 2 -- CDC Monitoring Agent

Responsibilities: - Subscribe to Kafka topics - Process change events -
Ensure idempotency - Update Qdrant

Agents must operate in parallel.

------------------------------------------------------------------------

# 8. Deployment Architecture

All services deployed via Docker Compose:

Services: - n8n - Qdrant - Ollama - Kafka - Debezium - Zookeeper (if
required) - kind cluster (external) - Playwright test runner

------------------------------------------------------------------------

# 9. Test Scenarios

## 9.1 Functional Tests

1.  All Kubernetes resources must be indexed in Qdrant.
2.  Insert/Update/Delete must reflect in vector database.
3.  No duplicate entries allowed.
4.  CDC must trigger automatically on etcd changes.
5.  AI flow must correctly answer namespace + resource count query.
6.  Output must be formatted as a structured table.

## 9.2 E2E Tests (Playwright)

Playwright must validate:

-   Create resource → Verify Qdrant update
-   Update resource → Verify vector replacement
-   Delete resource → Verify vector removal
-   Ask AI query → Validate structured output

------------------------------------------------------------------------

# 10. Non-Functional Requirements

-   Near real-time sync (\<5 seconds latency)
-   Horizontal scalability
-   Fault tolerance in Kafka
-   Idempotent vector updates
-   Resource-efficient local AI inference

------------------------------------------------------------------------

# 11. Restriction

- Kubernetes cluster only kind
- ETCD in kind kubernetes cluster
- All component n8n, ollama and AI model must run locally
- n8n, Qdrant vector database must run inside docker compose and must able to connect with localhost ollama runnint on host machine
- All the e2e must need to pass

------------------------------------------------------------------------

# 12. Conclusion

This system provides a fully automated AI-powered Kubernetes knowledge
platform that:

-   Continuously monitors cluster state
-   Maintains a synchronized vector database
-   Enables intelligent querying via local LLM
-   Ensures deduplication and idempotency
-   Supports automated end-to-end validation
