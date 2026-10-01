Vou comparar essa lógica com o Rill existente, separando claramente o que já existe, o que está conceitualmente correto e o que ainda falta para a troca de agentes e o botão de aprovação funcionarem com segurança. Não farei alterações nesta etapa.

Ran terminal command: npm run rill:classify -- "Analise a arquitetura Rill para orquestrar Qwen, seleção automática de modelos OpenRouter, Agent Loop, aprovação humana e encerramento da missão"

## Roteamento Rill

CLASSIFICATION: RILL_BOOTSTRAP  
ACTION: ANALYZE_RILL_PRODUCTION_FLOW  
DOMAIN: RillSystem  
SPECIALIST: Planner  
CONTEXT_LEVEL: L3  
STATUS: ALLOWED  
REASON: Análise autorizada da operação do Rill

## Conclusão

A lógica desejada está correta, mas precisa de uma separação importante:

- **Qwen** é o agente de entrada e coordenação conversacional.
- **Rill** é o controlador determinístico.
- **OpenRouter** é o gateway.
- **Agent Loop** é a execução governada.
- **Gemini, GPT, Claude ou Sonnet** são especialistas escolhidos pelo Registry.
- **Você** continua sendo o aprovador humano.
- **Executor** aplica somente o que foi aprovado.

O Qwen não deve decidir sozinho qual modelo chamar. Ele deve apenas enviar a solicitação ao Rill.

## Fluxo correto

1. Você conversa com o Qwen.
2. O Qwen chama `rill_create_request`.
3. O Rill classifica a solicitação.
4. O Rill resolve o contexto permitido.
5. O Rill escolhe o perfil:
   - `LOW_COST`;
   - `STANDARD`;
   - `HIGH_CONFIDENCE`.
6. O catálogo resolve o modelo real no OpenRouter.
7. O Workflow inicia o Agent Loop.
8. O especialista gera plano ou proposta.
9. O Reviewer valida.
10. O Workflow entra em `AWAITING_HUMAN_APPROVAL`.
11. Você clica em Allow/Aprovar.
12. O Workflow recebe `APPROVED`.
13. O Executor aplica a mudança autorizada.
14. Testes e telemetria são executados.
15. A missão termina em estado terminal.
16. A interface volta a mostrar o Qwen como agente de conversa.

## O que está correto na ideia

A separação abaixo é adequada:

| Função | Responsável |
|---|---|
| Conversa inicial | Qwen |
| Classificação e escopo | Rill |
| Escolha de perfil | Rill |
| Escolha do modelo efetivo | Catálogo OpenRouter |
| Planejamento | Estrategista |
| Proposta técnica | Projetista |
| Auditoria | Reviewer |
| Aprovação | Usuário humano |
| Aplicação | Executor determinístico |
| Estado e pausa | Cloudflare Workflow |

## O que não deve acontecer

O Qwen não deve:

- escolher diretamente `gpt`, `claude` ou `gemini`;
- ler todo o repositório;
- gerar código antes da classificação;
- aprovar a própria proposta;
- chamar diretamente o Executor;
- alterar o estado HITL;
- assumir que qualquer pedido pertence ao AuditQ.

O modelo do especialista também não deve ser fixado em texto como “Sonnet 5” ou “GPT 5.6”. Esses nomes são apenas exemplos. O Registry deve solicitar um perfil e o catálogo deve resolver o identificador configurado.

## Seleção de modelos

A lógica deve ser baseada em perfis:

| Perfil | Tipo de tarefa | Modelo |
|---|---|---|
| `LOW_COST` | análise simples, triagem, planejamento curto | modelo configurado para baixo custo |
| `STANDARD` | revisão técnica comum, síntese, proposta moderada | modelo configurado para qualidade intermediária |
| `HIGH_CONFIDENCE` | alteração complexa, risco alto, revisão crítica | modelo premium configurado |

A decisão deve ser:

`solicitação → ação → domínio → risco → perfil → modelo`

Nunca:

`solicitação → Qwen escolhe livremente um model ID`

## Troca visual do agente

A troca de modelo pode aparecer no relatório do Rill:

- Agente atual: `Qwen`
- Perfil selecionado: `LOW_COST`
- Especialista chamado: `Planner`
- Modelo efetivo: modelo retornado pelo catálogo OpenRouter
- Estado: `PLANNING`

Porém, a troca automática do nome no seletor visual do Cline não deve ser presumida. O Cline pode continuar mostrando Qwen na interface enquanto o Rill exibe que outro modelo foi usado internamente.

Portanto, existem duas identidades diferentes:

- **Agente de interface**: Qwen no Cline;
- **Modelo especialista de execução**: OpenRouter, selecionado pelo Rill.

Isso é correto e mais seguro.

## Aprovação Allow

O botão Allow não deve ser uma aprovação genérica do Cline.

Ele deve representar uma decisão HITL vinculada a:

- `executionId`;
- `ticketId`;
- hash da proposta;
- usuário autenticado;
- timestamp;
- justificativa;
- estado atual do Workflow.

Fluxo:

`PATCH_PROPOSAL → REVIEWED → AWAITING_HUMAN_APPROVAL → APPROVED → EXECUTOR`

Se o usuário clicar Allow depois que a proposta mudou, a aprovação deve ser rejeitada por divergência de hash.

## Credencial do MCP

O token de sessão colocado no `cline_mcp_settings.json` representa uma sessão humana. Esse modelo é frágil porque:

- expira;
- depende do login;
- pode ser invalidado pelo logout;
- mistura identidade humana e cliente técnico;
- foi exposto no arquivo compartilhado.

O modelo permanente recomendado é:

- MCP usa uma credencial técnica própria para criar requests e consultar execuções;
- sessão humana é usada exclusivamente para aprovação HITL;
- MCP não recebe permissão de aprovação;
- MCP não recebe permissão de execução;
- MCP não recebe permissão de deploy.

Não se deve usar `SUPABASE_SERVICE_ROLE_KEY` como token do MCP. Essa chave é administrativa demais.

## Estado atual do projeto

Já existem:

- `POST /api/internal/rill/requests`;
- `GET /api/internal/rill/executions/:executionId`;
- endpoint de decisão;
- Workflow `RILL_EXECUTION`;
- classificação;
- Context Resolver;
- Gateway OpenRouter;
- MCP com três ferramentas;
- espera por aprovação humana;
- telemetria Langfuse;
- testes do Agent Loop.

Ainda precisam ser consolidados para o comportamento ideal:

1. catálogo com perfis `LOW_COST`, `STANDARD` e `HIGH_CONFIDENCE`;
2. seleção real de modelo por etapa;
3. persistência definitiva do estado da execução;
4. persistência real dos tickets HITL;
5. separação entre credencial MCP e sessão humana;
6. interface de aprovação vinculada ao ticket;
7. Executor protegido por hash e aprovação;
8. retorno formal ao estado de conversa do Qwen;
9. política de transição para evitar múltiplas execuções concorrentes;
10. relatório final de missão.

## Arquitetura final desejada

O sistema deve funcionar assim:

`Você → Qwen → Rill → Registry → Context Resolver → Workflow → Especialista OpenRouter → Reviewer → HITL → Executor → Testes → Langfuse → Mission Completed`

O Qwen inicia a conversa, mas não controla a execução.

O Rill controla a execução, mas não é um modelo.

O especialista trabalha, mas não aprova.

Você aprova, mas não precisa coordenar tecnicamente cada etapa.

O Workflow espera, retoma e encerra.

## Decisão

A proposta é válida e compatível com o que está sendo construído, com estas correções fundamentais:

- Qwen deve ser apenas cliente de entrada;
- Rill deve decidir ação, escopo e perfil;
- OpenRouter deve resolver o modelo;
- Cline não deve trocar necessariamente o modelo visualmente;
- Allow deve ser uma decisão HITL formal;
- MCP deve usar credencial técnica própria;
- sessão humana deve permanecer exclusiva para aprovação;
- o ciclo deve terminar em estado terminal explícito.

Essa separação elimina o risco de o Qwen virar um agente autônomo e mantém o Rill como autoridade central.