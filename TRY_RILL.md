## Como testar o Rill no Cline

### 1. Reinicie o VS Code

Feche e abra novamente o VS Code para o Cline carregar:

- `mcp.json`
- `00-rill-governance.md`

### 2. Confirme o MCP

No painel do Cline:

1. Abra **MCP Servers**.
2. Verifique se `rill-control-plane` está ativo.
3. Confirme estas ferramentas:
   - `rill_healthcheck`;
   - `rill_create_request`;
   - `rill_get_execution`;
   - `rill_get_proposal`;
   - `rill_get_report`.
4. Confirme que `rill_submit_decision` não aparece.
5. Mantenha `autoApprove` vazio.
6. Mantenha YOLO Mode desativado.

### 3. Teste o healthcheck

No Cline, solicite:

> Execute somente o healthcheck do Rill. Não leia arquivos e não execute outras ferramentas.

Resultado esperado:

```text
baseUrlPresent: true
clientIdPresent: true
clientSecretPresent: true
timeoutMs: 15000
```

O healthcheck não chama produção.

### 4. Teste um pedido inválido

Envie:

> Crie um componente React para uma tela de login.

Resultado esperado:

```text
status: BLOCKED
reason: UNKNOWN_DOMAIN
```

O Cline não deve:

- ler arquivos;
- gerar código;
- abrir o terminal;
- chamar OpenRouter;
- criar Workflow.

### 5. Teste um pedido sem contexto suficiente

Envie:

> Analise a UI da página Audit Q.

Resultado esperado:

```text
status: CONTEXT_EXPANSION_REQUIRED
```

Isso ocorre porque o Rill exige um arquivo explícito.

### 6. Teste uma solicitação válida

Envie:

> Analise a UI da página Audit Q em public/index.html.

O Cline deve chamar primeiro:

```text
rill_create_request
```

Resultado esperado:

```text
HTTP: 202
status: READY
action: PLAN_CHANGE
domain: AuditQ
specialist: Planner
reason: CONTEXT_READY
workflowState: CLASSIFIED
executionId: rill-...
```

### 7. Consultar a execução

Use o `executionId` retornado e peça:

> Consulte o estado da execução Rill retornada. Não execute nenhuma alteração.

O Cline deve chamar:

```text
rill_get_execution
```

Estados esperados:

```text
queued
running
waiting
complete
errored
```

Na aplicação Rill, o estado lógico esperado é:

```text
AWAITING_HUMAN_APPROVAL
```

### 8. Validar a proposta

Depois que o Workflow produzir uma saída, peça:

> Consulte somente a proposta da execução Rill.

O Cline deve chamar:

```text
rill_get_proposal
```

Ele deve exibir apenas dados minimizados, sem:

- tokens;
- cookies;
- secrets;
- PII;
- prompt completo;
- payload bruto de domínio.

### 9. Confirmar a aprovação humana

O Cline não pode aprovar.

A aprovação deve ocorrer pela interface SaaS autenticada, usando:

```text
APPROVED
REJECTED
REQUESTED_CHANGES
```

O MCP não deve possuir `rill_submit_decision`.

### 10. Consultar o relatório final

Após a aprovação e a conclusão do Workflow, peça:

> Consulte o relatório final da execução Rill.

O Cline deve chamar:

```text
rill_get_report
```

O relatório deve conter:

- `executionId`;
- estado terminal;
- ação;
- domínio;
- especialista;
- perfil/modelo;
- custo;
- tokens;
- arquivos alterados;
- testes;
- Reviewer;
- decisão humana;
- trace Langfuse;
- rollback;
- riscos residuais.

Estado final esperado:

```text
COMPLETED
```

## Teste completo recomendado

Use esta sequência:

```text
1. Execute o healthcheck do Rill.
2. Crie uma solicitação válida para public/index.html.
3. Consulte o executionId retornado.
4. Consulte a proposta.
5. Aprove somente pela interface humana do SaaS.
6. Consulte novamente o estado.
7. Consulte o relatório final.
```

O teste é considerado correto quando:

- o primeiro tool call é `rill_create_request`;
- o Cline não lê arquivos antes do Rill;
- pedidos inválidos são bloqueados;
- o Workflow é criado;
- a aprovação exige usuário humano;
- o MCP não consegue aprovar;
- a execução termina em estado terminal;
- o relatório final é retornado.