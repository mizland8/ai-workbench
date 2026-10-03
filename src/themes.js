// Color themes and fonts. A theme is its terminal palette; the app's own colors are worked out
// from it unless the theme names them (`ui`). Plain data so the store can check saved choices.

// [id, name, background, foreground, cursor, selection, accent, the 16 ANSI colors, options]
const dark = [
  ['terminal', 'Terminal', '#121717', '#d3ddd7', '#90cba3', '#2f4d3a', '#90cba3',
    '#1c2321 #e57f7f #90cba3 #e2c77f #86b4e0 #c9a2e0 #7fc8c2 #d3ddd7 #64716b #f09a9a #aee0bd #f0d99a #a6c9ef #dcbcef #9fdcd6 #f2f6f3',
    { ui: { bg: '#101313', pane: '#121717', chrome: '#191f1e', text: '#d3ddd7', dim: '#88948d', border: '#303a34', accent: '#90cba3', selection: '#243b2c', ready: '#90cba3', warn: '#e2c77f', danger: '#e57f7f', working: '#86b4e0' } }],
  ['dark-modern', 'Dark Modern (VS Code)', '#1f1f1f', '#cccccc', '#aeafad', '#264f78', '#0078d4',
    '#000000 #cd3131 #0dbc79 #e5e510 #2472c8 #bc3fbc #11a8cd #e5e5e5 #666666 #f14c4c #23d18b #f5f543 #3b8eea #d670d6 #29b8db #e5e5e5', { chrome: '#181818' }],
  ['dark-plus', 'Dark+ (VS Code)', '#1e1e1e', '#d4d4d4', '#aeafad', '#264f78', '#007acc',
    '#000000 #cd3131 #0dbc79 #e5e510 #2472c8 #bc3fbc #11a8cd #e5e5e5 #666666 #f14c4c #23d18b #f5f543 #3b8eea #d670d6 #29b8db #e5e5e5', { chrome: '#252526' }],
  ['github-dark', 'GitHub Dark', '#0d1117', '#e6edf3', '#2f81f7', '#264f78', '#2f81f7',
    '#484f58 #ff7b72 #3fb950 #d29922 #58a6ff #bc8cff #39c5cf #b1bac4 #6e7681 #ffa198 #56d364 #e3b341 #79c0ff #d2a8ff #56d4dd #ffffff', { chrome: '#010409' }],
  ['github-dark-dimmed', 'GitHub Dark Dimmed', '#22272e', '#adbac7', '#539bf5', '#2e4c77', '#539bf5',
    '#545d68 #f47067 #57ab5a #c69026 #539bf5 #b083f0 #39c5cf #909dab #636e7b #ff938a #6bc46d #daaa3f #6cb6ff #dcbdfb #56d4dd #cdd9e5', { chrome: '#1c2128' }],
  ['one-dark-pro', 'One Dark Pro', '#282c34', '#abb2bf', '#528bff', '#3e4451', '#61afef',
    '#3f4451 #e06c75 #98c379 #e5c07b #61afef #c678dd #56b6c2 #d7dae0 #5c6370 #ff7b86 #b1e18b #f0d197 #74bfff #de8bf0 #6dcfd9 #ffffff', { chrome: '#21252b' }],
  ['dracula', 'Dracula', '#282a36', '#f8f8f2', '#f8f8f2', '#44475a', '#bd93f9',
    '#21222c #ff5555 #50fa7b #f1fa8c #bd93f9 #ff79c6 #8be9fd #f8f8f2 #6272a4 #ff6e6e #69ff94 #ffffa5 #d6acff #ff92df #a4ffff #ffffff', { chrome: '#21222c' }],
  ['monokai', 'Monokai', '#272822', '#f8f8f2', '#f8f8f0', '#49483e', '#a6e22e',
    '#272822 #f92672 #a6e22e #f4bf75 #66d9ef #ae81ff #a1efe4 #f8f8f2 #75715e #f92672 #a6e22e #f4bf75 #66d9ef #ae81ff #a1efe4 #f9f8f5', { chrome: '#1e1f1c' }],
  ['monokai-pro', 'Monokai Pro', '#2d2a2e', '#fcfcfa', '#fcfcfa', '#5b595c', '#ffd866',
    '#403e41 #ff6188 #a9dc76 #ffd866 #fc9867 #ab9df2 #78dce8 #fcfcfa #727072 #ff6188 #a9dc76 #ffd866 #fc9867 #ab9df2 #78dce8 #fcfcfa', { chrome: '#221f22' }],
  ['tokyo-night', 'Tokyo Night', '#1a1b26', '#c0caf5', '#c0caf5', '#33467c', '#7aa2f7',
    '#15161e #f7768e #9ece6a #e0af68 #7aa2f7 #bb9af7 #7dcfff #a9b1d6 #414868 #f7768e #9ece6a #e0af68 #7aa2f7 #bb9af7 #7dcfff #c0caf5', { chrome: '#16161e' }],
  ['tokyo-night-storm', 'Tokyo Night Storm', '#24283b', '#c0caf5', '#c0caf5', '#2e3c64', '#7aa2f7',
    '#1d202f #f7768e #9ece6a #e0af68 #7aa2f7 #bb9af7 #7dcfff #a9b1d6 #414868 #f7768e #9ece6a #e0af68 #7aa2f7 #bb9af7 #7dcfff #c0caf5', { chrome: '#1f2335' }],
  ['catppuccin-mocha', 'Catppuccin Mocha', '#1e1e2e', '#cdd6f4', '#f5e0dc', '#45475a', '#cba6f7',
    '#45475a #f38ba8 #a6e3a1 #f9e2af #89b4fa #f5c2e7 #94e2d5 #bac2de #585b70 #f38ba8 #a6e3a1 #f9e2af #89b4fa #f5c2e7 #94e2d5 #a6adc8', { chrome: '#181825' }],
  ['catppuccin-macchiato', 'Catppuccin Macchiato', '#24273a', '#cad3f5', '#f4dbd6', '#494d64', '#c6a0f6',
    '#494d64 #ed8796 #a6da95 #eed49f #8aadf4 #f5bde6 #8bd5ca #b8c0e0 #5b6078 #ed8796 #a6da95 #eed49f #8aadf4 #f5bde6 #8bd5ca #a5adcb', { chrome: '#1e2030' }],
  ['catppuccin-frappe', 'Catppuccin Frappé', '#303446', '#c6d0f5', '#f2d5cf', '#51576d', '#ca9ee6',
    '#51576d #e78284 #a6d189 #e5c890 #8caaee #f4b8e4 #81c8be #b5bfe2 #626880 #e78284 #a6d189 #e5c890 #8caaee #f4b8e4 #81c8be #a5adce', { chrome: '#292c3c' }],
  ['nord', 'Nord', '#2e3440', '#d8dee9', '#d8dee9', '#434c5e', '#88c0d0',
    '#3b4252 #bf616a #a3be8c #ebcb8b #81a1c1 #b48ead #88c0d0 #e5e9f0 #4c566a #bf616a #a3be8c #ebcb8b #81a1c1 #b48ead #8fbcbb #eceff4', { chrome: '#272c36' }],
  ['solarized-dark', 'Solarized Dark', '#002b36', '#839496', '#93a1a1', '#073642', '#268bd2',
    '#073642 #dc322f #859900 #b58900 #268bd2 #d33682 #2aa198 #eee8d5 #657b83 #cb4b16 #586e75 #657b83 #839496 #6c71c4 #93a1a1 #fdf6e3', { chrome: '#00212b' }],
  ['gruvbox-dark', 'Gruvbox Dark', '#282828', '#ebdbb2', '#ebdbb2', '#504945', '#fabd2f',
    '#282828 #cc241d #98971a #d79921 #458588 #b16286 #689d6a #a89984 #928374 #fb4934 #b8bb26 #fabd2f #83a598 #d3869b #8ec07c #ebdbb2', { chrome: '#1d2021' }],
  ['night-owl', 'Night Owl', '#011627', '#d6deeb', '#80a4c2', '#1d3b53', '#82aaff',
    '#011627 #ef5350 #22da6e #addb67 #82aaff #c792ea #21c7a8 #ffffff #575656 #ef5350 #22da6e #ffeb95 #82aaff #c792ea #7fdbca #ffffff', { chrome: '#010e1a' }],
  ['material-darker', 'Material Darker', '#212121', '#eeffff', '#ffcc00', '#404040', '#80cbc4',
    '#000000 #f07178 #c3e88d #ffcb6b #82aaff #c792ea #89ddff #ffffff #545454 #f07178 #c3e88d #ffcb6b #82aaff #c792ea #89ddff #ffffff', { chrome: '#1a1a1a' }],
  ['material-ocean', 'Material Ocean', '#0f111a', '#a6accd', '#ffcc00', '#1f2233', '#84ffff',
    '#000000 #f07178 #c3e88d #ffcb6b #82aaff #c792ea #89ddff #ffffff #464b5d #f07178 #c3e88d #ffcb6b #82aaff #c792ea #89ddff #ffffff', { chrome: '#090b10' }],
  ['palenight', 'Palenight', '#292d3e', '#a6accd', '#ffcc00', '#444267', '#c792ea',
    '#292d3e #f07178 #c3e88d #ffcb6b #82aaff #c792ea #89ddff #d0d0d0 #434758 #ff8b92 #ddffa7 #ffe585 #9cc4ff #e1acff #a3f7ff #ffffff', { chrome: '#202331' }],
  ['ayu-dark', 'Ayu Dark', '#0b0e14', '#bfbdb6', '#e6b450', '#1b3a5b', '#e6b450',
    '#01060e #ea6c73 #7fd962 #f9af4f #53bdfa #cda1fa #90e1c6 #c7c7c7 #686868 #f07178 #aad94c #ffb454 #59c2ff #d2a6ff #95e6cb #ffffff'],
  ['ayu-mirage', 'Ayu Mirage', '#1f2430', '#cccac2', '#ffcc66', '#33415e', '#ffcc66',
    '#191e2a #ed8274 #87d96c #facc6e #6dcbfa #dabafa #90e1c6 #c7c7c7 #686868 #f28779 #d5ff80 #ffd173 #73d0ff #dfbfff #95e6cb #ffffff', { chrome: '#1a1f29' }],
  ['rose-pine', 'Rosé Pine', '#191724', '#e0def4', '#ebbcba', '#403d52', '#c4a7e7',
    '#26233a #eb6f92 #31748f #f6c177 #9ccfd8 #c4a7e7 #ebbcba #e0def4 #6e6a86 #eb6f92 #31748f #f6c177 #9ccfd8 #c4a7e7 #ebbcba #e0def4', { chrome: '#1f1d2e', ready: '#9ccfd8' }],
  ['rose-pine-moon', 'Rosé Pine Moon', '#232136', '#e0def4', '#ea9a97', '#44415a', '#c4a7e7',
    '#393552 #eb6f92 #3e8fb0 #f6c177 #9ccfd8 #c4a7e7 #ea9a97 #e0def4 #6e6a86 #eb6f92 #3e8fb0 #f6c177 #9ccfd8 #c4a7e7 #ea9a97 #e0def4', { chrome: '#2a273f', ready: '#9ccfd8' }],
  ['kanagawa', 'Kanagawa', '#1f1f28', '#dcd7ba', '#c8c093', '#2d4f67', '#7e9cd8',
    '#16161d #c34043 #76946a #c0a36e #7e9cd8 #957fb8 #6a9589 #c8c093 #727169 #e82424 #98bb6c #e6c384 #7fb4ca #938aa9 #7aa89f #dcd7ba', { chrome: '#16161d' }],
  ['everforest-dark', 'Everforest Dark', '#2d353b', '#d3c6aa', '#d3c6aa', '#475258', '#a7c080',
    '#475258 #e67e80 #a7c080 #dbbc7f #7fbbb3 #d699b6 #83c092 #d3c6aa #859289 #e67e80 #a7c080 #dbbc7f #7fbbb3 #d699b6 #83c092 #d3c6aa', { chrome: '#232a2e' }],
  ['nightfox', 'Nightfox', '#192330', '#cdcecf', '#cdcecf', '#2b3b51', '#719cd6',
    '#393b44 #c94f6d #81b29a #dbc074 #719cd6 #9d79d6 #63cdcf #dfdfe0 #575860 #d16983 #8ebaa4 #e0c989 #86abdc #baa1e2 #7ad5d6 #e4e4e5', { chrome: '#131a24' }],
  ['moonlight', 'Moonlight', '#222436', '#c8d3f5', '#c8d3f5', '#2d3f76', '#82aaff',
    '#1b1d2b #ff757f #c3e88d #ffc777 #82aaff #c099ff #86e1fc #828bb8 #444a73 #ff757f #c3e88d #ffc777 #82aaff #c099ff #86e1fc #c8d3f5', { chrome: '#1e2030' }],
  ['horizon', 'Horizon', '#1c1e26', '#d5d8da', '#e95378', '#2e303e', '#e95378',
    '#16161c #e95678 #29d398 #fab795 #26bbd9 #ee64ac #59e1e3 #d5d8da #5b5858 #ec6a88 #3fdaa4 #fbc3a7 #3fc4de #f075b5 #6be4e6 #d5d8da', { chrome: '#232530' }],
  ['synthwave-84', "SynthWave '84", '#262335', '#f0eff1', '#f97e72', '#463465', '#ff7edb',
    '#262335 #fe4450 #72f1b8 #fede5d #03edf9 #ff7edb #03edf9 #ffffff #614d85 #fe4450 #72f1b8 #f97e72 #03edf9 #ff7edb #03edf9 #ffffff', { chrome: '#1e1a2e' }],
  ['shades-of-purple', 'Shades of Purple', '#2d2b55', '#ffffff', '#fad000', '#5a4fa0', '#fad000',
    '#000000 #ec3a37 #3ad900 #fad000 #6943ff #ff2c70 #00c5c7 #c7c7c7 #686868 #ff6274 #43d426 #f1d000 #6871ff #ff76ff #79e8fb #ffffff', { chrome: '#1e1e3f' }],
  ['cobalt2', 'Cobalt2', '#193549', '#ffffff', '#ffc600', '#0050a4', '#ffc600',
    '#000000 #ff0000 #38de21 #ffe50a #1460d2 #ff005d #00bbbb #bbbbbb #555555 #f40e17 #3bd01d #edc809 #5555ff #ff55ff #6ae3fa #ffffff', { chrome: '#15232d' }],
  ['oceanic-next', 'Oceanic Next', '#1b2b34', '#c0c5ce', '#c0c5ce', '#4f5b66', '#6699cc',
    '#1b2b34 #ec5f67 #99c794 #fac863 #6699cc #c594c5 #5fb3b3 #c0c5ce #65737e #ec5f67 #99c794 #fac863 #6699cc #c594c5 #5fb3b3 #d8dee9'],
  ['tomorrow-night', 'Tomorrow Night', '#1d1f21', '#c5c8c6', '#c5c8c6', '#373b41', '#81a2be',
    '#1d1f21 #cc6666 #b5bd68 #f0c674 #81a2be #b294bb #8abeb7 #c5c8c6 #969896 #cc6666 #b5bd68 #f0c674 #81a2be #b294bb #8abeb7 #ffffff'],
  ['darcula', 'Darcula (JetBrains)', '#2b2b2b', '#a9b7c6', '#bbbbbb', '#214283', '#cc7832',
    '#000000 #ff6b68 #a8c023 #d6bf55 #5394ec #ae8abe #299999 #999999 #555555 #ff8785 #a8c023 #ffff00 #7eaef1 #ff99ff #6cdada #ffffff', { chrome: '#3c3f41' }],
  ['xcode-dark', 'Xcode Dark', '#1f1f24', '#dfdfe0', '#ffffff', '#515b70', '#fc5fa3',
    '#000000 #ff8170 #78c2b3 #d9c97c #4eb0cc #ff7ab2 #b281eb #dfdfe0 #7f8c98 #ff8170 #acf2e4 #ffa14f #6bdfff #ff7ab2 #dabaff #ffffff', { chrome: '#292a30' }],
  ['mariana', 'Mariana (Sublime)', '#303841', '#d8dee9', '#f9ae58', '#4e5a65', '#6699cc',
    '#303841 #ec5f66 #99c794 #f9ae58 #6699cc #c695c6 #5fb4b4 #d8dee9 #a6acb9 #ec5f66 #99c794 #f9ae58 #6699cc #c695c6 #5fb4b4 #ffffff', { chrome: '#2b323a' }],
  ['poimandres', 'Poimandres', '#1b1e28', '#a6accd', '#a6accd', '#303340', '#5de4c7',
    '#1b1e28 #d0679d #5de4c7 #fffac2 #89ddff #fcc5e9 #add7ff #ffffff #506477 #d0679d #5de4c7 #fffac2 #add7ff #fae4fc #89ddff #ffffff'],
  ['vesper', 'Vesper', '#101010', '#ffffff', '#ffc799', '#343434', '#ffc799',
    '#101010 #f5a191 #90b99f #e6b99d #aca1cf #e29eca #ea83a5 #a0a0a0 #7e7e7e #ff8080 #99ffe4 #ffc799 #b9aeda #ecaad6 #f591b2 #ffffff'],
  ['andromeda', 'Andromeda', '#23262e', '#d5ced9', '#f8f8f0', '#3d4352', '#00e8c6',
    '#23262e #ee5d43 #96e072 #ffe66d #7cb7ff #c74ded #00e8c6 #d5ced9 #5f6167 #ee5d43 #96e072 #ffe66d #7cb7ff #ff00aa #00e8c6 #ffffff', { chrome: '#1e2025' }],
  ['panda', 'Panda', '#292a2b', '#e6e6e6', '#ff4b82', '#404954', '#19f9d8',
    '#1f1f20 #ff2c6d #19f9d8 #ffb86c #45a9f9 #ff75b5 #b084eb #cdcdcd #808080 #ff2c6d #19f9d8 #ffcc95 #6fc1ff #ff9ac1 #bcaafe #e6e6e6'],
  ['flexoki-dark', 'Flexoki Dark', '#100f0f', '#cecdc3', '#cecdc3', '#403e3c', '#4385be',
    '#100f0f #d14d41 #879a39 #d0a215 #4385be #ce5d97 #3aa99f #878580 #575653 #af3029 #66800b #ad8301 #205ea6 #a02f6f #24837b #cecdc3', { chrome: '#1c1b1a' }],
  ['campbell', 'Campbell (Windows Terminal)', '#0c0c0c', '#cccccc', '#ffffff', '#3a3a3a', '#3b78ff',
    '#0c0c0c #c50f1f #13a10e #c19c00 #0037da #881798 #3a96dd #cccccc #767676 #e74856 #16c60c #f9f1a5 #3b78ff #b4009e #61d6d6 #f2f2f2'],
  ['powershell', 'PowerShell', '#012456', '#eeeeee', '#f5de84', '#1d5a96', '#f5de84',
    '#0c0c0c #ff6b78 #3fd13a #f9f1a5 #6d9bff #e05ad2 #61d6d6 #cccccc #8a97a8 #ff8f99 #6fe36a #fff5b8 #9dbcff #f08ae6 #8ee8e8 #f2f2f2',
    { ui: { bg: '#012456', pane: '#012456', chrome: '#08356b', text: '#eeeeee', dim: '#9eb6d0', border: '#285381', accent: '#f5de84', selection: '#164f82', ready: '#7fe0a0', warn: '#f5de84', danger: '#ff8f99', working: '#9dbcff' } }],
  ['ubuntu', 'Ubuntu', '#300a24', '#eeeeec', '#bbbbbb', '#5e2750', '#e95420',
    '#2e3436 #cc0000 #4e9a06 #c4a000 #3465a4 #75507b #06989a #d3d7cf #555753 #ef2929 #8ae234 #fce94f #729fcf #ad7fa8 #34e2e2 #eeeeec', { ready: '#8ae234', working: '#729fcf' }],
];

const light = [
  ['light-modern', 'Light Modern (VS Code)', '#ffffff', '#3b3b3b', '#000000', '#add6ff', '#005fb8',
    '#000000 #cd3131 #00bc00 #949800 #0451a5 #bc05bc #0598bc #555555 #666666 #cd3131 #14ce14 #b5ba00 #0451a5 #bc05bc #0598bc #a5a5a5', { chrome: '#f8f8f8' }],
  ['light-plus', 'Light+ (VS Code)', '#ffffff', '#000000', '#000000', '#add6ff', '#007acc',
    '#000000 #cd3131 #00bc00 #949800 #0451a5 #bc05bc #0598bc #555555 #666666 #cd3131 #14ce14 #b5ba00 #0451a5 #bc05bc #0598bc #a5a5a5', { chrome: '#f3f3f3' }],
  ['github-light', 'GitHub Light', '#ffffff', '#1f2328', '#0969da', '#b6e3ff', '#0969da',
    '#24292f #cf222e #116329 #4d2d00 #0969da #8250df #1b7c83 #6e7781 #57606a #a40e26 #1a7f37 #633c01 #218bff #a475f9 #3192aa #8c959f', { chrome: '#f6f8fa' }],
  ['one-light', 'One Light', '#fafafa', '#383a42', '#526fff', '#e5e5e6', '#4078f2',
    '#383a42 #e45649 #50a14f #c18401 #4078f2 #a626a4 #0184bc #a0a1a7 #696c77 #e45649 #50a14f #c18401 #4078f2 #a626a4 #0184bc #fafafa', { chrome: '#eaeaeb' }],
  ['solarized-light', 'Solarized Light', '#fdf6e3', '#657b83', '#586e75', '#eee8d5', '#268bd2',
    '#073642 #dc322f #859900 #b58900 #268bd2 #d33682 #2aa198 #eee8d5 #586e75 #cb4b16 #586e75 #657b83 #839496 #6c71c4 #93a1a1 #fdf6e3', { chrome: '#eee8d5' }],
  ['gruvbox-light', 'Gruvbox Light', '#fbf1c7', '#3c3836', '#3c3836', '#d5c4a1', '#076678',
    '#fbf1c7 #cc241d #98971a #d79921 #458588 #b16286 #689d6a #7c6f64 #928374 #9d0006 #79740e #b57614 #076678 #8f3f71 #427b58 #3c3836', { chrome: '#ebdbb2' }],
  ['catppuccin-latte', 'Catppuccin Latte', '#eff1f5', '#4c4f69', '#dc8a78', '#ccd0da', '#8839ef',
    '#5c5f77 #d20f39 #40a02b #df8e1d #1e66f5 #ea76cb #179299 #acb0be #6c6f85 #d20f39 #40a02b #df8e1d #1e66f5 #ea76cb #179299 #bcc0cc', { chrome: '#e6e9ef' }],
  ['rose-pine-dawn', 'Rosé Pine Dawn', '#faf4ed', '#575279', '#d7827e', '#dfdad9', '#907aa9',
    '#f2e9e1 #b4637a #286983 #ea9d34 #56949f #907aa9 #d7827e #575279 #9893a5 #b4637a #286983 #ea9d34 #56949f #907aa9 #d7827e #575279', { chrome: '#fffaf3', ready: '#56949f' }],
  ['tokyo-night-day', 'Tokyo Night Day', '#e1e2e7', '#3760bf', '#3760bf', '#b6bfe2', '#2e7de9',
    '#e9e9ed #f52a65 #587539 #8c6c3e #2e7de9 #9854f1 #007197 #6172b0 #a1a6c5 #f52a65 #587539 #8c6c3e #2e7de9 #9854f1 #007197 #3760bf', { chrome: '#d0d5e3' }],
  ['ayu-light', 'Ayu Light', '#fcfcfc', '#5c6166', '#ffaa33', '#d1e4f4', '#d9730d',
    '#000000 #ea6c6d #6cbf43 #eca944 #3199e1 #9e75c7 #46ba94 #bababa #686868 #f07171 #86b300 #f2ae49 #399ee6 #a37acc #4cbf99 #d1d1d1', { chrome: '#f3f4f5' }],
  ['everforest-light', 'Everforest Light', '#fdf6e3', '#5c6a72', '#5c6a72', '#e6e2cc', '#8da101',
    '#5c6a72 #f85552 #8da101 #dfa000 #3a94c5 #df69ba #35a77c #dfddc8 #939f91 #f85552 #8da101 #dfa000 #3a94c5 #df69ba #35a77c #dfddc8', { chrome: '#f4f0d9' }],
  ['light-owl', 'Light Owl', '#fbfbfb', '#403f53', '#90a7b2', '#e0e0e0', '#4876d6',
    '#403f53 #de3d3b #08916a #e0af02 #288ed7 #d6438a #2aa298 #bdbdbd #7a8181 #de3d3b #08916a #daaa01 #288ed7 #d6438a #2aa298 #f0f0f0', { chrome: '#f0f0f0' }],
  ['quiet-light', 'Quiet Light', '#f5f5f5', '#333333', '#54494b', '#c9d0d9', '#705697',
    '#000000 #aa3731 #448c27 #9c5d27 #4b69c6 #7a3e9d #0598bc #555555 #777777 #cd3131 #14ce14 #b5ba00 #0451a5 #bc05bc #0598bc #a5a5a5', { chrome: '#ececec' }],
  ['xcode-light', 'Xcode Light', '#ffffff', '#262626', '#000000', '#b4d8fd', '#0b4f79',
    '#262626 #d12f1b #3e8087 #78492a #0b4f79 #ad3da4 #804fb8 #8a99a6 #8a99a6 #d12f1b #23575c #78492a #0b4f79 #ad3da4 #4b21b0 #b4d8fd', { chrome: '#f4f4f4' }],
  ['flexoki-light', 'Flexoki Light', '#fffcf0', '#100f0f', '#100f0f', '#e6e4d9', '#205ea6',
    '#100f0f #af3029 #66800b #ad8301 #205ea6 #a02f6f #24837b #6f6e69 #b7b5ac #d14d41 #879a39 #d0a215 #4385be #ce5d97 #3aa99f #cecdc3', { chrome: '#f2f0e5' }],
  ['nord-light', 'Nord Light', '#eceff4', '#2e3440', '#5e81ac', '#d8dee9', '#5e81ac',
    '#3b4252 #bf616a #5f8a4e #b08b3c #5e81ac #a0729a #3f8492 #d8dee9 #4c566a #bf616a #6a9a57 #c4973f #81a1c1 #b48ead #4c96a3 #e5e9f0', { chrome: '#e5e9f0' }],
  ['macos-basic', 'macOS Basic', '#ffffff', '#000000', '#7f7f7f', '#a4c9ff', '#0a5fd6',
    '#000000 #990000 #00a600 #999900 #0000b2 #b200b2 #00a6b2 #bfbfbf #666666 #e50000 #00d900 #e5e500 #0000ff #e500e5 #00e5e5 #e5e5e5', { chrome: '#ececec' }],
  ['paper', 'Paper', '#f2eede', '#1f1f1f', '#1f1f1f', '#d8d2bb', '#1e6fcc',
    '#1f1f1f #b3261e #2f7d32 #8a6d00 #1e6fcc #8e44ad #00838f #7a7566 #6b675b #d0312d #3c9a40 #a88600 #3f8ee6 #a35ac4 #009aa8 #fbf8ec', { chrome: '#e8e3cf' }],
  ['sepia', 'Sepia', '#f4ecd8', '#5b4636', '#a0522d', '#e2d3b3', '#a0522d',
    '#5b4636 #a33b2c #5d7a2b #9a6a12 #3d6a8f #8b4a76 #3b7a72 #8f7a62 #8f7a62 #c0503f #6f9232 #b58020 #4f81aa #a45c8d #4a9187 #fbf6ea', { chrome: '#ebdfc4' }],
];

const contrast = [
  ['high-contrast-dark', 'High Contrast Dark', '#000000', '#ffffff', '#ffffff', '#264f78', '#f38518',
    '#000000 #ff5555 #55ff55 #ffff55 #5c9dff #ff55ff #55ffff #ffffff #9a9a9a #ff7a7a #7aff7a #ffff7a #8ab8ff #ff7aff #7affff #ffffff', { dim: '#c8c8c8', border: '#6fc3df' }],
  ['high-contrast-light', 'High Contrast Light', '#ffffff', '#000000', '#000000', '#a6d0ff', '#0f4a85',
    '#000000 #b5200d #006100 #6b4c00 #0f4a85 #8f0f7c #00575b #4a4a4a #3a3a3a #9b1b0b #004d00 #5a3f00 #0b3a6a #730c64 #004649 #6a6a6a', { dim: '#3a3a3a', border: '#0f4a85' }],
];

const retro = [
  ['amber', 'Amber', '#18150e', '#dbc9a6', '#e1b56c', '#4a3b22', '#e1b56c',
    '#211c13 #e08a6f #b8c27a #e1b56c #9db0c8 #d39fb4 #a9c2b0 #dbc9a6 #776a52 #f0a58c #cfd896 #f0cb8a #b9c8da #e4b9ca #c2d6c8 #f3e6cc',
    { ui: { bg: '#15120c', pane: '#18150e', chrome: '#211c13', text: '#dbc9a6', dim: '#9e8d70', border: '#433927', accent: '#e1b56c', selection: '#3a2e1c', ready: '#b8c27a', warn: '#e1b56c', danger: '#e08a6f', working: '#9db0c8' } }],
  ['green-phosphor', 'Green Phosphor', '#0a0f0a', '#33ff66', '#33ff66', '#1a4d26', '#33ff66',
    '#0a0f0a #66ff99 #33ff66 #99ff99 #22cc55 #55ee88 #44ff88 #33ff66 #1f7a3a #88ffaa #55ff88 #bbffbb #44dd77 #77ffaa #66ffaa #ccffdd', { dim: '#1fa844' }],
  ['amber-phosphor', 'Amber Phosphor', '#120b00', '#ffb000', '#ffb000', '#4d3500', '#ffb000',
    '#120b00 #ffcc55 #ffb000 #ffd27f #e09a00 #ffbf40 #ffc440 #ffb000 #7a5400 #ffdd88 #ffc233 #ffe0a0 #f0aa20 #ffcc66 #ffd060 #fff0cc', { dim: '#a87400' }],
  ['homebrew', 'Homebrew', '#000000', '#00ff00', '#23ff18', '#083905', '#00ff00',
    '#000000 #990000 #00a600 #999900 #0000b2 #b200b2 #00a6b2 #bfbfbf #666666 #e50000 #00d900 #e5e500 #0000ff #e500e5 #00e5e5 #e5e5e5', { dim: '#00a600' }],
  ['ms-dos', 'MS-DOS', '#000000', '#aaaaaa', '#aaaaaa', '#0000aa', '#55ffff',
    '#000000 #aa0000 #00aa00 #aa5500 #0000aa #aa00aa #00aaaa #aaaaaa #555555 #ff5555 #55ff55 #ffff55 #5555ff #ff55ff #55ffff #ffffff', { working: '#5555ff' }],
  ['blue-screen', 'Blue Screen', '#0000aa', '#ffffff', '#ffffff', '#5555ff', '#ffff55',
    '#000000 #ff5555 #55ff55 #ffff55 #55ffff #ff55ff #55ffff #aaaaaa #555555 #ff5555 #55ff55 #ffff55 #aaaaff #ff55ff #55ffff #ffffff', { chrome: '#00007a', working: '#55ffff' }],
  ['commodore-64', 'Commodore 64', '#40318d', '#a59fe6', '#a59fe6', '#6c5eb5', '#a59fe6',
    '#090300 #883932 #55a049 #bfce72 #7869c4 #8b3f96 #67b6bd #ffffff #6c6c6c #b86962 #94e089 #ffff99 #a59fe6 #b86fc2 #9ae0e6 #ffffff', { chrome: '#352878', dim: '#9a93e8' }],
  ['cyberpunk', 'Cyberpunk', '#000b1e', '#0abdc6', '#ea00d9', '#1c61c2', '#ea00d9',
    '#123e7c #ff0000 #00ff9c #f57800 #3b8eea #d300c4 #0abdc6 #d7d7d5 #1c61c2 #ff3d3d #00ff9c #ffb000 #5ea8ff #ff4ef0 #42f2ff #ffffff'],
];

const GROUPS = [['Dark', dark], ['Light', light], ['High contrast', contrast], ['Retro', retro]];
const LIGHT = new Set([...light, ...contrast.filter(t => t[0].endsWith('light'))].map(t => t[0]));

const ansiNames = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];

function hex(color) {
  const n = parseInt(color.slice(1), 16);
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
}

// `amount` of `b` mixed into `a`.
export function mix(a, b, amount) {
  const [x, y] = [hex(a), hex(b)];
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * amount).toString(16).padStart(2, '0')).join('');
}

function build([id, name, background, foreground, cursor, selection, accent, ansi, options = {}], group) {
  const colors = ansi.split(' ');
  const terminal = { background, foreground, cursor, cursorAccent: background, selectionBackground: selection };
  ansiNames.forEach((key, i) => { terminal[key] = colors[i]; });
  const isLight = LIGHT.has(id);
  const ui = options.ui ?? {
    bg: background, pane: background,
    chrome: options.chrome ?? mix(background, foreground, isLight ? 0.04 : 0.05),
    text: foreground,
    dim: options.dim ?? mix(foreground, background, isLight ? 0.3 : 0.42),
    border: options.border ?? mix(background, foreground, isLight ? 0.16 : 0.18),
    accent,
    selection: mix(background, accent, isLight ? 0.16 : 0.22),
    ready: options.ready ?? colors[2], warn: colors[3], danger: colors[1], working: options.working ?? colors[4],
  };
  return { id, name, group, light: isLight, terminal, ui };
}

export const THEME_LIST = GROUPS.flatMap(([group, themes]) => themes.map(t => build(t, group)));
export const THEMES = Object.fromEntries(THEME_LIST.map(t => [t.id, t]));
export const THEME_GROUPS = GROUPS.map(([group]) => group);
export const DEFAULT_THEME = 'terminal';

// Coding fonts that come with the app, so they look the same on every computer and need no
// download. "System" is each platform's own monospace font.
export const FONT_LIST = [
  ['system', 'System default'],
  ['jetbrains-mono', 'JetBrains Mono'], ['fira-code', 'Fira Code'], ['fira-mono', 'Fira Mono'],
  ['cascadia-code', 'Cascadia Code'], ['source-code-pro', 'Source Code Pro'], ['ibm-plex-mono', 'IBM Plex Mono'],
  ['roboto-mono', 'Roboto Mono'], ['ubuntu-mono', 'Ubuntu Mono'], ['inconsolata', 'Inconsolata'],
  ['geist-mono', 'Geist Mono'], ['commit-mono', 'Commit Mono'], ['monaspace-neon', 'Monaspace Neon'],
  ['monaspace-argon', 'Monaspace Argon'], ['victor-mono', 'Victor Mono'],
  ['maple-mono', 'Maple Mono'], ['intel-one-mono', 'Intel One Mono'], ['atkinson-hyperlegible-mono', 'Atkinson Hyperlegible Mono'],
  ['noto-sans-mono', 'Noto Sans Mono'], ['red-hat-mono', 'Red Hat Mono'], ['dm-mono', 'DM Mono'],
  ['space-mono', 'Space Mono'], ['martian-mono', 'Martian Mono'], ['azeret-mono', 'Azeret Mono'],
  ['sometype-mono', 'Sometype Mono'], ['overpass-mono', 'Overpass Mono'], ['anonymous-pro', 'Anonymous Pro'],
  ['courier-prime', 'Courier Prime'], ['share-tech-mono', 'Share Tech Mono'], ['vt323', 'VT323 (retro)'],
].map(([id, name]) => ({ id, name }));
export const FONTS = Object.fromEntries(FONT_LIST.map(f => [f.id, f]));
export const DEFAULT_FONT = 'system';
