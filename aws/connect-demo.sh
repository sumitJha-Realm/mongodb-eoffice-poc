#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--help" ]]; then
  printf '%s\n' \
    'Usage: bash aws/connect-demo.sh [--check]' \
    'Refresh SSH access for your current public IPv4 and open local demo tunnels.' \
    'Requires AWS CLI credentials with EC2 describe and ingress authorization permissions.' \
    'Dashboard: http://127.0.0.1:8080/workflow.html' \
    'Ops Manager: http://127.0.0.1:8081' \
    'Override local ports with DEMO_PORT and OPS_PORT. Ctrl-C stops the tunnels.' \
    '--check resolves the instance and security group without changing rules or connecting.'
  exit 0
fi
if [[ $# -gt 1 || ( $# -eq 1 && "$1" != "--check" ) ]]; then
  printf '%s\n' 'Unknown argument; use --help.' >&2
  exit 1
fi

cd "$(dirname "$0")/.."
source aws/instance.env
export AWS_DEFAULT_REGION="${AWS_REGION:-ap-south-1}"
export AWS_PAGER=""
for command in aws curl ssh; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$command" >&2
    exit 1
  fi
done
if [[ ! -r "$PEM" ]]; then
  printf 'SSH key not readable: %s\n' "$PEM" >&2
  exit 1
fi
DEMO_PORT="${DEMO_PORT:-8080}"
OPS_PORT="${OPS_PORT:-8081}"
for port in "$DEMO_PORT" "$OPS_PORT"; do
  if [[ ! "$port" =~ ^[0-9]{1,5}$ ]] || (( 10#$port < 1024 || 10#$port > 65535 )); then
    printf 'Invalid local port: %s (use 1024-65535)\n' "$port" >&2
    exit 1
  fi
done
if (( 10#$DEMO_PORT == 10#$OPS_PORT )); then
  printf '%s\n' 'DEMO_PORT and OPS_PORT must be different.' >&2
  exit 1
fi

if ! details="$(aws ec2 describe-instances --instance-ids "$EC2_ID" \
  --query 'Reservations[0].Instances[0].[PublicIpAddress,State.Name]' --output text)"; then
  printf '%s\n' 'AWS lookup failed. Refresh your AWS CLI login/credentials and retry (for SSO: aws sso login --profile YOUR_PROFILE).' >&2
  exit 1
fi
read -r public_ip instance_state <<< "$details"
if [[ "$instance_state" != "running" || -z "$public_ip" || "$public_ip" == "None" ]]; then
  printf '%s\n' 'The instance must be running and have a public IPv4 address.' >&2
  exit 1
fi
group_id="$(aws ec2 describe-instances --instance-ids "$EC2_ID" \
  --query "Reservations[0].Instances[0].SecurityGroups[?GroupName=='${EC2_NAME}'].GroupId | [0]" --output text)"
if [[ ! "$group_id" =~ ^sg-[a-zA-Z0-9]+$ ]]; then
  printf 'Expected security group %s is not attached; refusing to modify other groups.\n' "$EC2_NAME" >&2
  exit 1
fi
my_ip="$(curl -4 -fsS --connect-timeout 5 --max-time 15 https://checkip.amazonaws.com)"
if [[ ! "$my_ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
  printf '%s\n' 'Could not determine your public IPv4 address.' >&2
  exit 1
fi
printf 'Instance: %s (%s)\nSSH access: %s/32 on %s, TCP/22 only\n' "$EC2_ID" "$public_ip" "$my_ip" "$group_id"
if [[ "${1:-}" == "--check" ]]; then
  printf '%s\n' 'Check complete. No security-group rules changed and no tunnel started.'
  exit 0
fi

if ! result="$(aws ec2 authorize-security-group-ingress --group-id "$group_id" \
  --ip-permissions "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=${my_ip}/32,Description=eOffice-local-demo-tunnel}]" 2>&1)"; then
  if [[ "$result" != *InvalidPermission.Duplicate* ]]; then
    printf '%s\n' "$result" 'Could not authorize SSH. Check AWS permissions; no tunnel started.' >&2
    exit 1
  fi
fi
printf '\nDashboard: http://127.0.0.1:%s/\nWorkbench: http://127.0.0.1:%s/workflow.html\nOps Manager: http://127.0.0.1:%s/\n' "$DEMO_PORT" "$DEMO_PORT" "$OPS_PORT"
printf '%s\n' 'Keep this terminal open. After a network change, press Ctrl-C and run this command again.'
printf '%s\n' 'Only the current /32 is added. Existing rules are not removed; periodically remove obsolete IP rules in AWS.'
exec ssh -i "$PEM" -N -T \
  -o StrictHostKeyChecking=accept-new \
  -o ExitOnForwardFailure=yes -o ConnectTimeout=15 \
  -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
  -L "127.0.0.1:${DEMO_PORT}:127.0.0.1:3001" \
  -L "127.0.0.1:${OPS_PORT}:127.0.0.1:30080" \
  "ec2-user@$public_ip"