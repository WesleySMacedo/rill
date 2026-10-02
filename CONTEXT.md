O objetivo principal do **Rill** é governar e controlar o uso de Inteligência Artificial

Ele funciona como uma camada determinística entre o usuário, os clientes de IA e o código do sistema. O Rill decide, com base em regras verificáveis:

- o que pode ser analisado;
- quais arquivos podem ser lidos;
- qual ação está autorizada;
- qual especialista e perfil de modelo devem ser usados;
- quais validações são obrigatórias;
- quando a aprovação humana é necessária;
- quando a execução deve ser bloqueada;
- quando a missão pode ser encerrada.

O Rill **não é um modelo de IA**, não é um chat e não deve agir como um assistente genérico. Cline, Continue, Copilot, Qwen, Gemini e outros modelos são apenas clientes ou executores subordinados ao Rill.

Em resumo:

```text
Usuário
→ Cliente de IA
→ Rill
→ Classificação e regras
→ Contexto permitido
→ Especialista
→ Validação
→ Aprovação humana
→ Execução autorizada
→ Encerramento
```

A finalidade central é permitir que a IA trabalhe com **segurança, escopo limitado, baixo custo, rastreabilidade e supervisão humana**, sem inventar contexto ou alterar o sistema fora das regras autorizadas.