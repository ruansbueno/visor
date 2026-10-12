# Checklist do gate de release (spec §3)

- [ ] Termos da Anthropic revisados; confirmação por escrito, se possível.
- [ ] Licença MIT presente e README com declaração de compliance (spec §3).
- [ ] **Histórico git:** os primeiros commits contêm fixtures com dados pessoais (caminho do usuário, e-mail, ids de sessão). Antes de publicar, recriar o repositório a partir do estado atual (sem histórico) ou reescrever o histórico.
- [ ] `grep -rn` por e-mail, nome de usuário e caminhos absolutos em todo o repositório.
- [ ] Faixa de versões do CLI testadas documentada (hoje: 2.1.267).
