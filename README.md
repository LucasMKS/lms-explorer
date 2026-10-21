# LMS Video Explorer 🎬⚡

<p align="center">
  <strong>Gerenciador e explorador de arquivos de vídeo desktop de alta performance, projetado para produtividade, catalogação e organização de bibliotecas de mídia.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Tauri-v2-blue?logo=tauri" alt="Tauri">
  <img src="https://img.shields.io/badge/Rust-1.80+-orange?logo=rust" alt="Rust">
  <img src="https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Vite-6.0+-646CFF?logo=vite" alt="Vite">
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License MIT">
  <img src="https://img.shields.io/badge/Platform-Windows-0078D6?logo=windows" alt="Windows">
</p>

---

## 🌟 Visão Geral

O **LMS Video Explorer** é uma aplicação desktop nativa desenvolvida com **Tauri 2**, **Rust** e **TypeScript**. Ela resolve o desafio de gerenciar, catalogar, buscar e reproduzir grandes bibliotecas locais de aulas, cursos (LMS), gravações e vídeos de produção, sem depender da lentidão de pastas convencionais do sistema operacional.

O sistema monitora pastas locais cadastradas, gera miniaturas em segundo plano utilizando aceleração local com FFmpeg, permite tagueamento granular com filtros booleanos, agrupamentos dinâmicos e controle de histórico de reprodução.

---

## ✨ Principais Funcionalidades

### 📁 Gestão de Projetos e Pastas
- Crie múltiplos projetos isolados para organizar temas, cursos ou clientes.
- Adicione múltiplas pastas raiz a um projeto, com opção para **incluir subpastas recursivamente** (ignorando automaticamente pastas ocultas e de sistema).
- Remova ou desvincule pastas em lote a qualquer momento.

### 🖼️ Miniaturas em Cache Inteligente
- Geração assíncrona multithread de thumbnails em alta definição via FFmpeg no backend Rust.
- Armazenamento em cache local no diretório do usuário para carregamento instantâneo nas próximas sessões.

### 📊 Modos de Visualização Flexíveis
- **Modo Grade (Cards)**: Visualização rica com miniaturas grandes, metadados (duração, resolução, peso) e etiquetas de tags.
- **Modo Tabela Detalhada**: Lista compacta estilo planilha com colunas ordenáveis (Título, Duração, Resolução, Tamanho, Formato, Reproduções, Última Visualização e Pasta).
- **Controle de Densidade**: Ajuste de tamanho de grade personalizável.

### 🗂️ Agrupamento Dinâmico (Group By)
Agrupe a exibição em seções expansíveis e colapsáveis:
- **Por Pasta de Origem**
- **Por Resolução** (4K UHD, 1080p Full HD, 720p HD, etc.)
- **Por Formato de Arquivo** (MP4, MKV, AVI, MOV, WEBM...)
- **Por Duração** (< 5 min, 5–15 min, 15–30 min, > 1h...)
- **Por Status de Tags** (Tagueados vs Não Tagueados)

### 🏷️ Sistema Avançado de Tags & Filtros Negados
- Crie tags coloridas personalizadas com cores vibrantes.
- Filtre vídeos combinando múltiplas tags.
- **Filtro de Exclusão (Tags Negadas)**: Clique com o botão direito sobre um chip de tag para torná-lo vermelho (`-tag`), ocultando todos os vídeos que a possuam.
- Filtros rápidos para **Apenas Favoritos** e **Sem Tags**.

### 🔄 Histórico & Contador de Visualizações
- Rastreamento automático de contagem de reproduções (`plays`) e carimbo de data/hora da última visualização.
- Ordenação direta por **"Mais assistidos"** ou **"Nunca assistidos"** para priorizar revisões de aulas e gravações.

### 🔍 Localizador de Vídeos Duplicados
- Varredura inteligente de duplicatas no acervo por tamanho exato em bytes e nome de arquivo.
- Interface dedicada para inspecionar pares ou grupos duplicados com opção para revelar no Explorer ou enviar para a lixeira.

### 📂 Operações de Arquivo no Disco
- **Mover ou Copiar** vídeos diretamente entre as pastas cadastradas no projeto pelo menu de contexto.
- **Renomear Arquivos** em disco com validação instantânea (`F2`).
- **Mover com segurança para a Lixeira nativa do Windows** (`Del`), sem risco de exclusão permanente acidental.
- Revelar arquivo no Explorador de Arquivos do Windows.

---

## ⌨️ Atalhos de Teclado

| Tecla / Atalho | Ação |
| :--- | :--- |
| `Ctrl + K` / `/` | Focar na barra de busca |
| `Ctrl + N` | Criar novo projeto |
| `F2` | Renomear arquivo selecionado |
| `Delete` | Mover vídeo selecionado para a Lixeira |
| `Espaço` / `Enter` | Reproduzir vídeo selecionado |
| `Botão Direito` | Menu de contexto Notion/Raycast style |
| `Clique Direito na Tag` | Alternar tag como excluída/negada (`-tag`) |
| `Esc` | Fechar modais, submenus ou limpar busca |

---

## 🚀 Como Executar em Desenvolvimento

### Pré-requisitos
1. [Node.js](https://nodejs.org/) (versão 18 ou superior)
2. [Rust & Cargo](https://rustup.rs/)
3. [FFmpeg](https://ffmpeg.org/) instalado e disponível na variável de ambiente `PATH` do Windows.

### Passos

```bash
# 1. Clone o repositório
git clone https://github.com/LucasMKS/lms-explorer.git
cd lms-explorer

# 2. Instale as dependências
npm install

# 3. Execute o ambiente de desenvolvimento (Vite + Tauri Dev)
npm run tauri dev
```

---

## 🔨 Gerando o Executável de Produção (.exe)

Para gerar o executável otimizado e o instalador do Windows:

```bash
npm run tauri build
```

Os arquivos compilados estarão disponíveis em:
- **Instalador NSIS**: `src-tauri/target/release/bundle/nsis/LMS Video Explorer_0.1.0_x64-setup.exe`
- **Instalador MSI**: `src-tauri/target/release/bundle/msi/LMS Video Explorer_0.1.0_x64_en-US.msi`
- **Executável Portátil**: `src-tauri/target/release/lms-explorer.exe`

---

## 🛡️ Licença

Este projeto é distribuído sob a licença **MIT**. Veja o arquivo [LICENSE](LICENSE) para mais detalhes.

---

<p align="center">
  Desenvolvido com carinho por <a href="https://github.com/LucasMKS">Lucas Marques (LucasMKS)</a>.
</p>
