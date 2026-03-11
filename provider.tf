terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.22.0, < 7.0"
    }
  }
}

provider "aws" {
  region = var.region
}

provider "aws" {
  alias  = "us-east-1"
  region = "us-east-1"
}
