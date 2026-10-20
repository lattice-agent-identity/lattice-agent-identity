terraform {
  required_providers {
    lattice = { source = "openagent-md/lattice", version = "2.33.6" }
    docker  = { source = "kreuzwerker/docker", version = "~> 3.6" }
  }
}
provider "docker" {}
data "lattice_provisioner" "me" {}
data "lattice_workspace" "me" {}
data "lattice_workspace_owner" "me" {}

data "lattice_parameter" "bootstrap_token" {
  name      = "identity_bootstrap_token"
  type      = "string"
  default   = ""
  mutable   = true
  ephemeral = true
}
data "lattice_parameter" "launch_id" {
  name    = "identity_launch_id"
  type    = "string"
  default = ""
  mutable = false
}
data "lattice_parameter" "launcher_url" {
  name    = "identity_launcher_url"
  type    = "string"
  default = ""
  mutable = false
}

resource "lattice_agent" "main" {
  arch = data.lattice_provisioner.me.arch
  os   = "linux"
  dir  = "/home/node/workspace"
  env = {
    IDENTITY_BOOTSTRAP_TOKEN = data.lattice_parameter.bootstrap_token.value
    IDENTITY_LAUNCH_ID       = data.lattice_parameter.launch_id.value
    IDENTITY_LAUNCHER_URL    = data.lattice_parameter.launcher_url.value
    IDENTITY_STATE_DIR       = "/home/node/.agent-identity"
  }
  startup_script = <<-EOT
    set -eu
    umask 077
    mkdir -p "$HOME/.agent-identity"
    nohup node /opt/identity/agent-runtime.mjs >> "$HOME/.agent-identity/runtime.log" 2>&1 &
  EOT
}
resource "docker_volume" "home" {
  name = "identity-${data.lattice_workspace.me.id}-home"
  lifecycle { ignore_changes = all }
  labels {
    label = "lattice.workspace_id"
    value = data.lattice_workspace.me.id
  }
}
resource "docker_container" "workspace" {
  count    = data.lattice_workspace.me.start_count
  image    = "lattice-identity-workspace:local"
  name     = "identity-${data.lattice_workspace.me.id}"
  hostname = data.lattice_workspace.me.name
  env = [
    "LATTICE_AGENT_TOKEN=${lattice_agent.main.token}",
    "LATTICE_AGENT_AUTH=token",
    "LATTICE_AGENT_URL=${data.lattice_workspace.me.access_url}/"
  ]
  memory      = 2048
  memory_swap = 2048
  cpu_period  = 100000
  cpu_quota   = 100000
  ulimit {
    name = "nproc"
    soft = 4096
    hard = 4096
  }
  security_opts = ["no-new-privileges:true"]
  capabilities { drop = ["ALL"] }
  volumes {
    container_path = "/home/node"
    volume_name    = docker_volume.home.name
  }
  labels {
    label = "lattice.workspace_id"
    value = data.lattice_workspace.me.id
  }
}
