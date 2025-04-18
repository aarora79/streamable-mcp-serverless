resource "aws_api_gateway_rest_api" "api" {
    name = "simple-mcp-server"
}

resource "aws_api_gateway_resource" "mcp" {
    rest_api_id = aws_api_gateway_rest_api.api.id
    parent_id = aws_api_gateway_rest_api.api.root_resource_id
    path_part = "mcp"
}

resource "aws_api_gateway_method" "any" {
    rest_api_id = aws_api_gateway_rest_api.api.id
    resource_id = aws_api_gateway_resource.mcp.id
    authorization = "NONE"
    http_method = "ANY"
}

resource "aws_api_gateway_integration" "lambda" {
    rest_api_id = aws_api_gateway_rest_api.api.id
    resource_id = aws_api_gateway_resource.mcp.id
    http_method = aws_api_gateway_method.any.http_method
    integration_http_method = "POST"
    type = "AWS_PROXY"
    uri = aws_lambda_function.simple_mcp_server.invoke_arn
}

resource "aws_lambda_permission" "apigateway" {
    statement_id = "AllowExecutionFromAPIGateway"
    action = "lambda:InvokeFunction"
    function_name = aws_lambda_function.simple_mcp_server.function_name
    principal = "apigateway.amazonaws.com"
    source_arn = "${aws_api_gateway_rest_api.api.execution_arn}/*/*/*"
}

resource "aws_api_gateway_deployment" "api" {
    rest_api_id = aws_api_gateway_rest_api.api.id
    depends_on = [aws_api_gateway_method.any, aws_api_gateway_integration.lambda]
    lifecycle {
      create_before_destroy = true
    }
    triggers = {
      redeployment = timestamp() //always
    }
}

resource "aws_api_gateway_stage" "dev" {
    rest_api_id = aws_api_gateway_rest_api.api.id
    deployment_id = aws_api_gateway_deployment.api.id
    stage_name = "dev"
}
