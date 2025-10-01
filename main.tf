#
# Local nvm presence check
#
resource "null_resource" "check_nvm" {
  provisioner "local-exec" {
    command = <<EOF
    if ! command -v nvm &> /dev/null; then
        echo "ERROR: nvm is not installed"
        exit 1
    fi
EOF
  }
}

#
# Local nodejs dependency install.
#
resource "null_resource" "provision_nodejs" {
  depends_on = [null_resource.check_nvm]
  provisioner "local-exec" {
    command = <<EOF
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
    
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

    nvm install -s ${var.nodejs_version}
    nvm use ${var.nodejs_version}
EOF
  }
}

#
# Lambda Packaging
#
resource "null_resource" "copy_source" {
  depends_on = [null_resource.provision_nodejs]

  triggers = {
    build_resource = null_resource.provision_nodejs.id
    always_run     = timestamp()
  }

  provisioner "local-exec" {
    command = <<EOF
if [ ! -d "build" ]; then
  if [ ! -L "build" ]; then
    curl -L https://github.com/mslipets/cloudfront-auth/archive/${var.cloudfront_auth_branch}.zip \
        --output cloudfront-auth-${var.cloudfront_auth_branch}.zip
    unzip -q cloudfront-auth-${var.cloudfront_auth_branch}.zip -d build/
    mkdir build/cloudfront-auth-${var.cloudfront_auth_branch}/distributions

    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash

    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

    nvm install -s ${var.nodejs_version}
    nvm use ${var.nodejs_version}
    cp ${data.local_file.build-js.filename} build/cloudfront-auth-${var.cloudfront_auth_branch}/build/build.js && \
    cp ${path.module}/auth.js build/cloudfront-auth-${var.cloudfront_auth_branch}/auth.js && \
    cp ${path.module}/index.js build/cloudfront-auth-${var.cloudfront_auth_branch}/index.js && \
    cd build/cloudfront-auth-${var.cloudfront_auth_branch} && npm i minimist shelljs && npm install && cd build && npm install
  fi
fi
EOF

  }
}

# Builds the Lambda zip artifact
resource "null_resource" "build_lambda" {
  depends_on = [null_resource.copy_source]

  # Trigger a rebuild on any variable change
  triggers = {
    copy_source             = null_resource.copy_source.id
    vendor                  = var.auth_vendor
    cloudfront_distribution = var.cloudfront_distribution
    client_id               = var.client_id
    client_secret           = var.client_secret
    base_uri                = var.base_uri
    redirect_uri            = var.redirect_uri
    session_duration        = var.session_duration
    authz                   = var.authz
  }

  provisioner "local-exec" {
    command = <<EOF
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && \
    export NVM_DIR="$HOME/.nvm" && \
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh" && \
    nvm install ${var.nodejs_version} && \
    nvm use ${var.nodejs_version} && \
    cd build/cloudfront-auth-${var.cloudfront_auth_branch} && \
    node build/build.js --AUTH_VENDOR=${var.auth_vendor} \
    --BASE_URL=${var.base_uri} \
    --CLOUDFRONT_DISTRIBUTION=${var.cloudfront_distribution} \
    --CLIENT_ID=${var.client_id} \
    --CLIENT_SECRET=${var.client_secret == "" ? "none" : var.client_secret} \
    --REDIRECT_URI=${var.redirect_uri} --HD=${var.hd} \
    --SESSION_DURATION=${var.session_duration} --AUTHZ=${var.authz} \
    --GITHUB_ORGANIZATION=${var.github_organization}
EOF
  }
}

# Copies the artifact to the root directory
resource "null_resource" "copy_lambda_artifact" {
  depends_on = [null_resource.build_lambda]
  triggers = {
    build_resource = null_resource.build_lambda.id
  }

  provisioner "local-exec" {
    command = "cp build/cloudfront-auth-${var.cloudfront_auth_branch}/distributions/${var.cloudfront_distribution}/${var.cloudfront_distribution}.zip ${local.lambda_filename}"
  }
}

# workaround to sync file creation
data "null_data_source" "lambda_artifact_sync" {
  inputs = {
    file    = local.lambda_filename
    trigger = null_resource.copy_lambda_artifact.id # this is for sync only
  }
}

data "local_file" "build-js" {
  filename = "${path.module}/build.js"
}

#
# Cloudfront
#
resource "aws_cloudfront_origin_access_control" "default" {
  name                              = "dlex-documents-oac"
  description                       = "OAC for DLEX release documents"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "default" {
  origin {
    domain_name = var.cloudfront_oac_name
    origin_id   = local.s3_origin_id

    origin_access_control_id = aws_cloudfront_origin_access_control.default.id
  }

  aliases             = concat([var.cloudfront_distribution], var.cloudfront_aliases)
  comment             = "Managed by Terraform"
  enabled             = true
  http_version        = "http2"
  is_ipv6_enabled     = true
  price_class         = var.cloudfront_price_class
  tags                = var.tags

  default_cache_behavior {
    target_origin_id = local.s3_origin_id

    // Read only
    allowed_methods = [
      "GET",
      "HEAD",
    ]

    cached_methods = [
      "GET",
      "HEAD",
    ]

    forwarded_values {
      query_string = true
      headers = [
        "Access-Control-Request-Headers",
        "Access-Control-Request-Method",
        "Origin",
      ]

      cookies {
        forward = "none"
      }
    }

    lambda_function_association {
      event_type = "viewer-request"
      lambda_arn = aws_lambda_function.default.qualified_arn
    }

    viewer_protocol_policy = "redirect-to-https"
  }

  restrictions {
    geo_restriction {
      restriction_type = (var.geo_restriction_whitelisted_locations == "") ? "none" : "whitelist"
      locations        = (var.geo_restriction_whitelisted_locations == "") ? [] : [var.geo_restriction_whitelisted_locations]
    }
  }

  viewer_certificate {
    acm_certificate_arn            = var.cloudfront_acm_certificate_arn
    ssl_support_method             = "sni-only"
    cloudfront_default_certificate = false
  }
}

#
# Lambda
#
data "aws_iam_policy_document" "lambda_log_access" {
  // Allow lambda access to logging
  statement {
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    resources = [
      "arn:aws:logs:*:*:*",
    ]

    effect = "Allow"
  }
}

# This function is created in us-east-1 as required by CloudFront.
resource "aws_lambda_function" "default" {
  depends_on = [null_resource.check_nvm, null_resource.copy_lambda_artifact]

  provider         = aws.us-east-1
  description      = "Managed by Terraform"
  runtime          = "nodejs18.x"
  role             = aws_iam_role.lambda_role.arn
  filename         = local.lambda_filename
  function_name    = "cloudfront_auth"
  handler          = "index.handler"
  publish          = true
  timeout          = 5
  source_code_hash = filebase64sha256(data.null_data_source.lambda_artifact_sync.outputs["file"])
  tags             = var.tags
}

data "aws_iam_policy_document" "lambda_assume_role" {
  // Trust relationships taken from blueprint
  // Allow lambda to assume this role.
  statement {
    actions = [
      "sts:AssumeRole",
    ]

    principals {
      type = "Service"
      identifiers = [
        "edgelambda.amazonaws.com",
        "lambda.amazonaws.com",
      ]
    }

    effect = "Allow"
  }
}

resource "aws_iam_role" "lambda_role" {
  name               = "lambda_role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
  tags               = var.tags
}

# Attach the logging access document to the above role.
resource "aws_iam_role_policy_attachment" "lambda_log_access" {
  role       = aws_iam_role.lambda_role.name
  policy_arn = aws_iam_policy.lambda_log_access.arn
}

# Create an IAM policy that will be attached to the role
resource "aws_iam_policy" "lambda_log_access" {
  name   = "cloudfront_auth_lambda_log_access"
  policy = data.aws_iam_policy_document.lambda_log_access.json
  tags   = var.tags
}

