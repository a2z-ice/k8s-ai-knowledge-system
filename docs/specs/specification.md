## Requirements
I want a AI base solution where user can query any question related to kubernetes and the AI k8s flow using n8n flow orcastation it wil give appropriate answer from qdrant vector database. 

The qudrand database will be updated by n8n cdc(change data capture)  flow. cdc (change data capture) pipeline will be listening all the kind's kubernetes cluster resources from kinds' etcd database. The cdc flow will be trigger when the cdc detect any changes insert/update/delete from etcd database. The cdc pieplien will make sure no duplicate data presented in vector database so it will perform delete first to the kubernetes resource if found from vector database and then insert it. So the kubernetes's resources uniqe key needed to be store to accomplished this type of action be performed by dcd pipeline. I prefer cdc stream base solution like debezium and kafka or give me the best solution from opensource.

Now as a user from n8n chat I will ask any question to the AI k8s flow related to kubernetes it will give me answer from bector database. The AI chat will be used by local ollama best chat model and to retrieve data from best embedding model allso needed to be used from ollama embedding model

## So I have two flow 
1. AI k8s flow
2. CDC(Change Data Capture) flow

## Test Scenarios
1. All kubernetes resourced to be found from kind kubernetes cluster in Qdrant vector database
2. The CDC pipeline must be perform insert/update/delete and will ensure the duplicated resources will be updated
3. Any resources created/updated/deleted in kind kubernetes cluster will be reflected by CDC pipeline 
4. Makesure the CDC pipeline will be triggered if any changes happenes insude kind's kubernetes cluster
5. The AI k8s flow will be asked how many namespaces will be inside kubernetes cluster and howmany resourced to each namespace? The alswer will be presentedd as a table formate like namespace name, and resources count 
6. The e2e test will be performed by playwright testing automation test



## Technologies

1. AI flow engin n8n
2. Vector database qdrant vector
3. AI model suitable for local OLLAMA
4. kind kubernetes cluster
5. ETDC from kind kubernetes cluster
6. n8n chat trigger
7. AI multi Agent for pattallel processing one for AI chat and another for continiously monitoring change to etcd database change and when found update the data into vector database
8. playwright e2e test
9. Dockercompose 
10. Kafka or suggest best opensource tools
11. debezium or suggest best opensource tools
