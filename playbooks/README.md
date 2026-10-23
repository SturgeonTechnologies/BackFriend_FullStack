# Playbooks

Ad-hoc automation playbooks that aren't part of the AWS deploy path.

## `decentriq-login.yml`

Logs in to the Decentriq API (`api.decentriq.vip`), captures the session
token, and optionally pulls the account profile to confirm the token is valid.
The login flow was derived from a captured browser session (HAR).

### What it does

1. Prompts for a **username** and **password** at the CLI (password is hidden).
2. `POST /ipa/user/login` with `{"name": ..., "password": ...}`.
3. Parses the JSON body (the API returns it under `Content-Type: text/html`,
   so the playbook parses the raw content with `from_json`).
4. Fails loudly if the API returns a non-success `code`.
5. Saves the token (`result.token`) as the `dq_token` fact.
6. Calls `POST /ipa/user/userinfo` with the `token:` header to prove it works,
   and prints a few profile fields.

### Requirements

- `ansible-core` (uses only `ansible.builtin` modules — no extra collections).

### Usage

Interactive (prompts for credentials):

```bash
ansible-playbook playbooks/decentriq-login.yml
```

Non-interactive (for automation — `vars_prompt` is skipped when the vars
already exist):

```bash
ansible-playbook playbooks/decentriq-login.yml \
    -e dq_username=yourname \
    -e dq_password='yourpassword'
```

Mint a token without the profile lookup:

```bash
ansible-playbook playbooks/decentriq-login.yml -e fetch_profile=false
```

### Variables

| Variable       | Default                      | Purpose                                   |
| -------------- | ---------------------------- | ----------------------------------------- |
| `dq_username`  | *(prompted)*                 | Account username                          |
| `dq_password`  | *(prompted, hidden)*         | Account password                          |
| `dq_base_url`  | `https://api.decentriq.vip`  | API base URL                              |
| `dq_origin`    | `https://decentriqnb.com`    | `Origin`/`Referer` sent with each request |
| `fetch_profile`| `true`                       | Set `false` to skip the `userinfo` call   |

### Notes

- The password is only ever supplied by you at runtime; the login task runs
  with `no_log: true` so the credential never lands in Ansible output or logs.
- Prefer passing secrets via a prompt or Ansible Vault over plain `-e` on the
  command line, which can leak into your shell history.
- Other authenticated endpoints observed in the capture, all taking the same
  `token:` header, if you want to extend the playbook:
  `POST /ipa/user/orderlist` `{"type": 0}`,
  `POST /ipa/user/matchingtasks` `{"time": <epoch_ms>}`,
  `POST /ipa/user/ordertj` `{}`,
  `GET /ipa/ad/config` (uses `x-token:` instead of `token:`).
