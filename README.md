# Rill — AI Mission Control Plane

> **ChatGPT responde. Cursor programa. Rill governa o trabalho.**

---

## O que é o Rill?

O Rill é um **AI Mission Control Plane** que transforma conversas em missões governadas, auditáveis e executáveis, mantendo o ser humano no controle de cada decisão crítica.

Em vez do fluxo ingênuo de prompts:
``
Prompt ➔ Resposta ➔ Edição Direta
``

O Rill executa um pipeline rigoroso de engenharia e governança:
``
Objetivo ➔ Classificação ➔ Escopo ➔ Estratégia ➔ Proposta ➔ Revisão ➔ Aprovação (HITL) ➔ Execução ➔ Auditoria
``

---

## O Conceito de Missão

No Rill, o usuário conversa apenas com o **Rill**. Não é necessário configurar dezenas de agentes nem escolher modelos manualmente. Toda conversa gera uma **Missão Auditável**.

### Ciclo de Vida da Missão:
1. CLASSIFIED: Classificação determinística Zero-LLM da ação e do domínio.
2. CONTEXT_READY: Resolução estrita do escopo de arquivos (llowedPaths vs orbiddenPaths).
3. PLANNED: Elaboração da estratégia read-only pelo papel de *Architect*.
4. PROPOSAL_CREATED: Geração do PATCH_PROPOSAL com hash criptográfico SHA-256.
5. PROPOSAL_REVIEWED: Auditoria técnica prévia pelo papel de *Reviewer* (anti-scope creep).
6. AWAITING_APPROVAL: Portão de aprovação humana (*Human-In-The-Loop*).
7. EXECUTING: Aplicação da alteração autorizada sob sandbox durável.
8. COMPLETED: Validação pós-execução, testes de regressão e telemetria OTel/Langfuse.

---

## Estrutura do Repositório

``text
src/
├── contracts/        # Contratos agnósticos de execução, gateway, custos e telemetria
├── classification/   # Classificador determinístico Zero-LLM
├── routing/          # Resolvedor de escopo, contexto e registry
├── policies/         # Motor de políticas de orçamento (budget) e limites
├── security/         # Gated executor (SHA-256), scope validator e sanitizadores
├── gateway/          # Gateway de modelos invisíveis com fallback e retentativas
├── telemetry/        # Observabilidade padronizada OpenTelemetry / Langfuse
├── workers/          # Workers especializados (Architect, Builder, Reviewer)
├── hitl/             # Casos de uso e ciclo de vida de tickets de aprovação humana
├── runtime/          # Agent loop central e entrypoints
├── workflows/        # Workflows duráveis Cloudflare Workflows
├── memory/           # Governança de working memory
└── cli/              # MCP Server (Model Context Protocol) para VS Code/Cursor
``

---

## Execução e Testes

``bash
# Instalar dependências
npm install

# Executar suíte de testes completa
npm test

# Iniciar servidor MCP
npm run mcp

# Executar classificador determinístico
npm run classify "Analise a tela em public/index.html"
``

---

## Licença

Apache-2.0
