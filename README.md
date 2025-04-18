# Simple MCP Server on Lambda

A simple MCP Server running natively on AWS Lambda and Amazon API Gateway without any extra bridging components or custom transports. This is now possible thanks to the [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) transport introduced in v2025-03-26. 

Architecture is as simple as it gets: 
![](architecture.png)

## Prereqs

* AWS CLI
* Terraform 

## Instructions

Install dependencies:
```bash
cd src
npm install
cd ..
```

Bootstrap server and set env var with MCP Server endpoint:
```bash
cd terraform
terraform init
terraform plan
terraform apply
export SIMPLE_MCP_SERVER_ENDPOINT=$(terraform output --raw endpoint_url) 
cd ..
```

> Note: It might take a few seconds for API Gateway endpoint to become operational. 


Run client:
```bash
node src/client.js
```

Observe the response:
```bash
> node client.js
> listTools response:  { tools: [ { name: 'ping', inputSchema: [Object] } ] }
> callTool:ping response:  { content: [ { type: 'text', text: 'pong' } ] }
```

## Learn about mcp
[Intro](https://modelcontextprotocol.io/introduction)

[Protocol specification](https://modelcontextprotocol.io/specification/2025-03-26)