# Plano: transformar o Rill em uma IDE governada

> Documento de acompanhamento da implementação. Marque `[x]` apenas quando o item tiver evidência verificável (teste, deploy, print ou link de trace). Status em 2026-10-02.

Legenda: ✅ concluído · 🟡 parcial · ⬜ não iniciado · ⛔ bloqueado

## 1. Objetivo

Permitir que um usuário:

1. Crie conta e faça login no Rill.
2. Carregue seu projeto (GitHub).
3. Peça no chat do Rill, por exemplo: "Faça um push do meu projeto para o GitHub na minha conta".
4. Receba do Rill, **sem LLM**, uma análise determinística completa: classificação, escopo, arquivos únicos de edição, riscos, complexidade, agente recomendado e custo estimado.
5. Aprove o plano.
6. Veja o Rill executar com o agente escolhido via OpenRouter (chave do próprio usuário), **estritamente** dentro do plano.
7. Receba a auditoria final com % de assertividade e relatório do que foi feito.
8. Reinicie o ciclo.

Tudo isso em uma interface com comportamento de VS Code/Cursor: menus, Explorer, editor, terminal.

## 2. Princípios inegociáveis

- Nenhum cliente, modelo ou agente tem autoridade própria; o Rill decide.
- Não alucinação: toda análise pré-aprovação é determinística.
- Redução de custo: LLM só quando a tarefa exige; operações determinísticas (git, testes, formatação) custam zero tokens.
- Baixíssimo risco de quebra: branch isolada, Sandbox isolado, lista fechada de arquivos, validação antes de concluir.
- Fail closed: se a segurança ou o escopo não puderem ser comprovados, a missão é bloqueada.
- Nenhum segredo no código, no navegador ou na telemetria.

## 3. Ajustes de projeto sobre os pedidos originais

| Pedido | Decisão | Motivo |
|---|---|---|
| Token único que não expira nos segredos da Cloudflare | `RILL_SERVICE_TOKEN` (serviço, rotacionável) + tokens pessoais `rill_pat_...` por usuário (sem expiração, revogáveis, com escopos, armazenados só como hash) | Um token mestre vazado comprometeria tudo |
| Chave OpenRouter pré-colocada pelo usuário | Armazenada cifrada (AES-GCM) no Supabase, com `RILL_ENCRYPTION_KEY` na Cloudflare; nunca retorna ao navegador nem ao Langfuse | Proteção de credenciais do usuário |
| "Faça um push para o GitHub" | Ação determinística `PUBLISH_CHANGE`: branch + Pull Request via GitHub App; push direto na `main` só com aprovação extra; force push proibido | O Executor não faz push; publicar é ação separada e aprovada |

## 4. Arquitetura alvo

```text
Navegador (Rill IDE)
 ├─ Menus File/Edit/Selection/View/Go/Run/Terminal/Help
 ├─ Explorer + Editor (Monaco) + Terminal (xterm.js)
 └─ Painel Rill (chat, plano, aprovação, auditoria)
        │ HTTPS / WebSocket
Cloudflare Worker (Rill API)
 ├─ Auth Supabase + tokens Rill
 ├─ Análise determinística (sem LLM)
 ├─ Workflow durável: Mission → Proposal → Approval → Execution → Validation → Audit
 ├─ Gateway OpenRouter (chave do usuário, perfil escolhido pelo plano)
 └─ Cloudflare Sandbox por projeto (repositório, git, node, testes, terminal)
Supabase: usuários, projetos, missões, aprovações, auditorias (RLS)
Langfuse: tracing, custo, prompts
GitHub App: importar repositório, branch, Pull Request
```

## 5. Ciclo do usuário

| # | Etapa | Responsável | LLM |
|---|---|---|---|
| 1 | Criar conta / login | Supabase Auth | Não |
| 2 | Conectar GitHub e escolher repositório | GitHub App → clone no Sandbox | Não |
| 3 | Cadastrar chave OpenRouter (uma vez) | Cofre cifrado | Não |
| 4 | Solicitação no chat | Rill | Não |
| 5 | Análise (classificação, Registry, inventário, dependências, riscos, complexidade) | Rill determinístico | **Não** |
| 6 | Plano + agente recomendado + custo estimado | Rill determinístico | **Não** |
| 7 | Aprovação humana | Usuário | Não |
| 8 | Execução estrita do plano | Agente via OpenRouter, ferramentas restritas | Só se necessário |
| 9 | Validação (diff, testes, lint, segredos) | Rill determinístico | Não |
| 10 | Auditoria com % de assertividade | Rill determinístico (+ revisor LLM opcional) | Opcional |
| 11 | Estado terminal e relatório; ciclo reinicia | Workflow | Não |

## 6. Análise determinística (sem LLM)

1. Classificação da intenção por regras → ação (`PUBLISH_CHANGE`, `PATCH_UI`, `PATCH_LOGIC`, `PLAN_CHANGE`, ...).
2. Verificação no Registry (ação × domínio autorizados).
3. Inventário: árvore, linguagens, gerenciador de pacotes, scripts de teste/build/lint, estado git.
4. Grafo de dependências (imports) para medir impacto.
5. Lista fechada de arquivos de edição, com hash de cada arquivo.
6. Detecção de risco: segredos, arquivos proibidos, ausência de testes.
7. Score de complexidade 0–100: nº de arquivos, linhas afetadas, dependentes, cobertura de testes, tipo de ação, risco do domínio.
8. Seleção de perfil de agente:

   | Complexidade | Perfil | Uso típico |
   |---|---|---|
   | 0 | Determinístico (sem LLM) | git, renomear, formatar, rodar testes |
   | 1–30 | `LOW_COST` (atual: `qwen/qwen3.8-flash`) | UI, textos |
   | 31–70 | `STANDARD` | lógica em poucos arquivos |
   | 71–100 | `HIGH_REASONING` | refatoração com muitas dependências |

9. Estimativa de custo (tokens × preço do catálogo) com teto, exibida antes da aprovação.

## 7. Execução governada

- Agente roda no Sandbox, em branch isolada.
- Ferramentas restritas: `read_file`/`write_file` apenas nos arquivos aprovados; terminal só com comandos do plano; sem rede além do OpenRouter.
- Limites rígidos de passos, tokens e custo; estouro → `FAILED`.
- Plano como lista de tarefas; ações fora da lista são recusadas pela ferramenta.
- Executor determinístico final confere: diff ⊆ arquivos aprovados, hash do plano, ausência de segredos, arquivos inalterados desde a análise.

## 8. Auditoria e % de assertividade

| Critério | Peso |
|---|---|
| Tarefas do plano concluídas | 30% |
| Arquivos alterados ⊆ aprovados (falha = nota zero e `BLOCKED`) | 20% |
| Testes passando | 25% |
| Lint e typecheck passando | 10% |
| Critérios de aceite cobertos | 10% |
| Custo dentro do estimado | 5% |

Relatório final: nota, feito × não feito, diff, custo real × estimado, tempo, link do PR.

## 9. IDE (comportamento VS Code/Cursor)

- Editor Monaco: abas, minimapa, busca, multicursor, diff lado a lado.
- Explorer: árvore com status git, menu de contexto, arrastar e soltar, filtro, atualização em tempo real; arquivos fora do escopo da missão com cadeado.
- Terminal xterm.js conectado ao Sandbox: múltiplas abas e divisão.
- Paleta de comandos (Ctrl+Shift+P) e atalhos padrão do VS Code.
- Edição manual humana invalida o hash de proposta pendente que toque os mesmos arquivos.

| Menu | Itens |
|---|---|
| File | Novo arquivo/pasta, Abrir projeto (GitHub), Salvar, Salvar tudo, Fechar editor, Preferências |
| Edit | Desfazer/Refazer, Recortar/Copiar/Colar, Localizar/Substituir, Localizar nos arquivos |
| Selection | Selecionar tudo, Expandir seleção, Copiar linha acima/abaixo, Multicursor |
| View | Paleta de comandos, Explorer, Busca, Controle de código, Painel Rill, Terminal, Problemas, Saída |
| Go | Ir para arquivo, Ir para linha, Voltar/Avançar, Próximo problema |
| Run | Nova missão Rill, Executar testes, Executar script, Pré-visualizar app |
| Terminal | Novo terminal, Dividir, Executar tarefa, Encerrar |
| Help | Documentação, Atalhos, Sobre o Rill |

## 10. Dados (Supabase, todas com RLS)

| Tabela | Conteúdo | Status |
|---|---|---|
| `rill_missions`, `rill_workflow_events`, `rill_approvals`, `rill_execution_state`, ... | Runtime de missão | ⛔ migração `web/supabase/migrations/202610010001_rill_mission_runtime.sql` não aplicada (PGRST205) |
| `profiles` | Dados do usuário | ⬜ |
| `projects` | Repositório, branch, id do Sandbox | ⬜ |
| `api_tokens` | Hash, escopos, último uso, revogação | ⬜ |
| `provider_credentials` | Chave OpenRouter cifrada | ⬜ |
| `analyses` | Inventário, grafo, complexidade | ⬜ |
| `plans` | Tarefas, arquivos, agente, custo, hash | ⬜ |
| `executions` | Passos do agente, diff, custo | ⬜ |
| `validations` | Testes, lint, varredura de segredos | ⬜ |
| `audits` | Nota e relatório | ⬜ |

## 11. Configuração Cloudflare

| Nome | Tipo | Finalidade | Status |
|---|---|---|---|
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | variável | Supabase | ✅ |
| `SUPABASE_SERVICE_ROLE_KEY` | segredo | Persistência server-side | ✅ |
| `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY` | variável | Langfuse | ✅ |
| `LANGFUSE_SECRET_KEY` | segredo | Langfuse | ✅ |
| `OPENROUTER_API_KEY` | segredo | Fallback do sistema | ✅ |
| `OPENROUTER_LOW_COST_MODEL` | variável | Perfil `LOW_COST` | ✅ |
| `RILL_SERVICE_TOKEN` | segredo | Rill ↔ MCP, rotacionável | ⬜ |
| `RILL_ENCRYPTION_KEY` | segredo | Cifrar chaves OpenRouter de usuários | ⬜ |
| `GITHUB_APP_ID` | variável | GitHub App | ⬜ |
| `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` | segredo | GitHub App | ⬜ |

Segredos são cadastrados no painel da Cloudflare ou com `npx wrangler secret put <NOME>` dentro de `web/`; nunca no código nem no chat.

## 12. Fases e checklist de verificação

### Fase 0 — Fundação (3–4 dias)

- [ ] Migração `202610010001_rill_mission_runtime.sql` aplicada no Supabase (evidência: `GET /rest/v1/rill_missions` ≠ PGRST205)
- [ ] Migração com `profiles`, `projects`, `api_tokens`, `provider_credentials`
- [ ] Token de serviço `RILL_SERVICE_TOKEN` aceito pela API (teste automatizado)
- [ ] Tokens pessoais: criar, listar, revogar; armazenados só como hash
- [ ] Cofre OpenRouter: cifra/decifra com `RILL_ENCRYPTION_KEY`; chave nunca retorna ao cliente (teste)
- [ ] Tela "Configurações": tokens e chave OpenRouter
- [ ] MCP (`src/cli/mcp-server.cjs`) apontando para `/api/missions`, com `rill_submit_decision`

### Fase 1 — Projetos (4–5 dias)

- [ ] GitHub App criada e instalável
- [ ] Importar repositório para um Sandbox por projeto
- [ ] Snapshot/backup do workspace no R2
- [ ] Sandbox dorme por inatividade; destruição ao remover projeto

### Fase 2 — IDE (7–10 dias)

- [ ] Barra de menus com todos os submenus da seção 9
- [ ] Explorer com status git, menu de contexto, arrastar e soltar, tempo real
- [ ] Editor Monaco com abas e diff
- [ ] Terminal xterm.js via WebSocket ao Sandbox, múltiplas abas
- [ ] Paleta de comandos e atalhos
- [ ] Painel Rill lateral (chat, plano, aprovação, auditoria)

### Fase 3 — Análise sem LLM (5–7 dias)

- [ ] Classificador ampliado (inclui `PUBLISH_CHANGE`, `PATCH_LOGIC`)
- [ ] Inventário do projeto
- [ ] Grafo de dependências
- [ ] Lista fechada de arquivos com hash
- [ ] Detecção de riscos e segredos
- [ ] Score de complexidade com testes de fórmula
- [ ] Seleção de perfil de agente e estimativa de custo
- [ ] Proposta automática de Registry por projeto (aprovada pelo usuário)

### Fase 4 — Mission + Proposal + Approval Runtime (3–4 dias)

- [x] API de missões (`/api/missions`, `/decision`, `/cancel`) com estados e 409 em conflito
- [x] Proposta `PATCH_UI` → Auditor determinístico → `AWAITING_HUMAN_APPROVAL`
- [x] Linha do tempo e controles de decisão/cancelamento na UI
- [x] Tracing Langfuse e prompt gerenciado com fallback local
- [ ] Migrar orquestração para Workflow durável (`rill-execution`)
- [ ] Hash do plano cobrindo todos os artefatos
- [ ] Teste E2E em produção (PLAN_CHANGE e PATCH_UI com aprovar/rejeitar)

### Fase 5 — Execution (7–10 dias)

- [ ] Agente governado no Sandbox com ferramentas restritas
- [ ] Limites de passos, tokens e custo
- [ ] Executor determinístico (diff ⊆ aprovados, hash, segredos, arquivos inalterados)
- [ ] Substituir `EXECUTOR_NOT_CONFIGURED` pelo fluxo real

### Fase 6 — Validation + Auditoria (4–5 dias)

- [ ] Testes, lint e typecheck no Sandbox
- [ ] Varredura de segredos no diff
- [ ] Cálculo da % de assertividade (seção 8) com testes
- [ ] Relatório final na UI e no Langfuse

### Fase 7 — Publicar (2–3 dias)

- [ ] `PUBLISH_CHANGE`: branch + Pull Request via GitHub App
- [ ] Push direto na `main` só com aprovação extra; force push bloqueado

### Fase 8 — Endurecimento (3–5 dias)

- [ ] Teste E2E do ciclo completo (login → projeto → missão → aprovação → execução → validação → auditoria → PR)
- [ ] Limites de custo por usuário
- [ ] Painéis Langfuse (custo, latência, assertividade)
- [ ] Revisão de segurança

## 13. Ordem de entrega com valor incremental

1. Fase 0 + 4 → o Rill decide e aprova; edição ainda no Cursor.
2. Fases 1 + 2 + 7 → desenvolvimento dentro do Rill e PR sem LLM.
3. Fases 3 + 5 + 6 → agente governado e auditoria fecham o ciclo.
4. Fase 8 → produção.

Estimativa total do MVP: 6 a 8 semanas.

## 14. Riscos e limites

| Risco | Mitigação |
|---|---|
| Custo de containers | Sleep após inatividade; um Sandbox por projeto ativo |
| Paridade total com VS Code (extensões, depurador) | Fora do MVP |
| Preview de app exige domínio curinga | Usar `*.rill.wesleysmacedo.com` |
| Registry cobre só AuditQ | Proposta automática de Registry por projeto na Fase 3 |
| Agente fugir do plano | Ferramentas restritas + Executor determinístico + validação |

## 15. Rill Agent (runtime local) — entregue em v0.1

O Rill Agent (`agent/`) foi adicionado como alternativa local ao Cloudflare Sandbox. Ele roda no computador do usuário (Windows, tray, `http://localhost:7777`) e executa arquivos, comandos do catálogo e Git somente nas pastas que o usuário aprovou.

- [x] Pareamento por código de dispositivo: Agent → `/agent/pair` → token pessoal `rill_pat_` guardado com DPAPI.
- [x] API local Express + WebSocket com Host/Origin allowlist, sessão local verificada pelo Worker e confinamento de caminhos.
- [x] Git `status`/`branch`/`commit`/`push` (push sempre com confirmação nativa e sem force).
- [x] npm `install`/`test`/`build`/`dev` com streaming em tempo real.
- [x] Worker `/api/agent/*`, status Connected/Disconnected e o diálogo "Rill Agent Required" no Rill Web.
- [x] Instalador NSIS `Rill-Agent-Setup.exe`.
- [x] Builds beta sem assinatura (NSIS + portable), via `npm run dist` ou pelo workflow `rill-agent-build.yml`.
- [ ] Assinatura de código (Authenticode) antes do lançamento público. Sem ela, o SmartScreen mostra o aviso e o Smart App Control pode bloquear.
- [ ] Publicar o instalador em GitHub Releases.
- [ ] Integrar Monaco, file watching, terminal interativo e execução de missões pelo Agent.

## 16. Bloqueio atual

⛔ Aplicar no SQL Editor do Supabase as migrações:

- `web/supabase/migrations/202610010001_rill_mission_runtime.sql`
- `web/supabase/migrations/202610020001_rill_agent.sql`

Sem elas, nenhuma missão é persistida em produção e o pareamento do Agent falha com `AGENT_PERSISTENCE_FAILED`.
