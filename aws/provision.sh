#!/usr/bin/env bash
# One-step AWS provisioning: EC2 (sumit-poc-bel-eoffice) + KMS key + IAM role + SG.
# Prereq: `aws configure` with an account allowed to create EC2/KMS/IAM.
# Idempotent — safe to re-run after the instance was deleted.
set -euo pipefail
cd "$(dirname "$0")"

NAME="sumit-poc-bel-eoffice"
REGION="${AWS_REGION:-ap-south-1}"
ITYPE="${ITYPE:-m6i.8xlarge}"
DISK_GB=1000 IOPS=10000 THROUGHPUT=700
MYIP="$(curl -s https://checkip.amazonaws.com)/32"
export AWS_DEFAULT_REGION="$REGION"

echo "==> Region=$REGION  Type=$ITYPE  MyIP=$MYIP"

# --- key pair ---
if ! aws ec2 describe-key-pairs --key-names "$NAME" >/dev/null 2>&1; then
  aws ec2 create-key-pair --key-name "$NAME" --query KeyMaterial --output text > "$NAME.pem"
  chmod 400 "$NAME.pem"
  echo "created key pair -> aws/$NAME.pem"
fi

# --- security group ---
VPC=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values="$NAME" Name=vpc-id,Values="$VPC" \
      --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo None)
if [ "$SG" = "None" ] || [ -z "$SG" ]; then
  SG=$(aws ec2 create-security-group --group-name "$NAME" --description "eoffice poc" --vpc-id "$VPC" --query GroupId --output text)
fi
for p in 22 80 30080 3001 3000; do
  aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port "$p" --cidr "$MYIP" 2>/dev/null || true
done
echo "security group: $SG (22/80/30080/3001/3000 from $MYIP)"

# --- KMS key for Queryable Encryption ---
KMS_ARN=$(aws kms describe-key --key-id alias/eoffice-poc-qe --query KeyMetadata.Arn --output text 2>/dev/null || echo "")
if [ -z "$KMS_ARN" ]; then
  KMS_ARN=$(aws kms create-key --description "eOffice PoC Queryable Encryption CMK" --query KeyMetadata.Arn --output text)
  aws kms create-alias --alias-name alias/eoffice-poc-qe --target-key-id "$KMS_ARN"
fi
echo "KMS key: $KMS_ARN"

# --- IAM role + instance profile (KMS access from the instance, no static creds) ---
if ! aws iam get-role --role-name "$NAME-role" >/dev/null 2>&1; then
  aws iam create-role --role-name "$NAME-role" --assume-role-policy-document '{
    "Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam put-role-policy --role-name "$NAME-role" --policy-name kms-qe --policy-document "{
    \"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",
    \"Action\":[\"kms:Encrypt\",\"kms:Decrypt\",\"kms:DescribeKey\",\"kms:GenerateDataKey*\"],
    \"Resource\":\"$KMS_ARN\"}]}"
  aws iam create-instance-profile --instance-profile-name "$NAME-profile" >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "$NAME-profile" --role-name "$NAME-role"
  sleep 10  # IAM propagation
fi

# --- launch (skip if already running) ---
IID=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=pending,running" \
      --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || echo None)
if [ "$IID" = "None" ] || [ -z "$IID" ]; then
  AMI=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 --query Parameter.Value --output text)
  IID=$(aws ec2 run-instances \
    --image-id "$AMI" --instance-type "$ITYPE" --key-name "$NAME" \
    --security-group-ids "$SG" \
    --iam-instance-profile Name="$NAME-profile" \
    --block-device-mappings "[{\"DeviceName\":\"/dev/xvda\",\"Ebs\":{\"VolumeSize\":$DISK_GB,\"VolumeType\":\"gp3\",\"Iops\":$IOPS,\"Throughput\":$THROUGHPUT,\"DeleteOnTermination\":true}}]" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
    --query 'Instances[0].InstanceId' --output text)
  echo "launched $IID — waiting for running..."
  aws ec2 wait instance-running --instance-ids "$IID"
fi
IP=$(aws ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)

cat > instance.env <<EOF
EC2_NAME=$NAME
EC2_ID=$IID
EC2_IP=$IP
PEM=aws/$NAME.pem
AWS_REGION=$REGION
AWS_KMS_KEY_ARN=$KMS_ARN
EOF
echo
echo "==> READY: $NAME  $IID  $IP   (details in aws/instance.env)"
echo "Next: ./aws/sync-and-run.sh"
