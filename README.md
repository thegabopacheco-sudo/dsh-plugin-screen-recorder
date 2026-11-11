# dsh-plugin-screen-recorder — Screen Recorder

Grabador de pantalla para DeepSeek Harness: graba el escritorio o una region con ffmpeg (gdigrab), lista grabaciones y usa rutas permitidas, confirmacion y auditoria.

## Herramientas

| Tool | Qué hace |
|---|---|
| `status` | Estado |
| `record` | Grabar pantalla |
| `list` | Listar grabaciones |

## Instalación

Desde **DSH → Settings → Plugins** instala `github:thegabopacheco-sudo/dsh-plugin-screen-recorder` y permite el script de instalación.

```
dsh plugin --profile <perfil> add github:thegabopacheco-sudo/dsh-plugin-screen-recorder
```

## Seguridad

- Lectura por defecto; escritura solo con `confirm:true` y pedido explícito.
- `DSH_SCREEN_RECORDER_MODE=read-only` desactiva acciones.
- Listas blancas y auditoría en `<DSH_HOME>\cache\screen-recorder\audit.jsonl`.

## Licencia

MIT © thegabopacheco-sudo
