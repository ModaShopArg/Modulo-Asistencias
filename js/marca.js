// Identidad visual MODASHOP (según el Manual de Marca) aplicada a Tailwind.
// Se usa en index.html y asistencias.html; cargar después de cdn.tailwindcss.com.
//
// Colores oficiales:
//   Magenta 100%  Pantone Process Magenta C  -> #E90089
//   Negro 100%    Pantone Process Black      -> #231F20
//   Negro 60%     Pantone Process Black      -> #818486
//   Rosa claro de apoyo (plano del manual)   -> #FFD7F1
//
// Las escalas `pink` y `slate` de Tailwind se reemplazan por tonos derivados de
// esos colores, así todo el sistema queda en la paleta de la marca.
// Tipografía: la marca usa Gotham Rounded (licencia paga); Nunito es la alternativa
// libre más parecida. Si tienen la licencia web de Gotham Rounded, se cambia acá.
tailwind.config = {
    theme: {
        extend: {
            fontFamily: {
                sans: ['"Gotham Rounded"', 'Nunito', 'sans-serif'],
            },
            colors: {
                brand: {
                    primary: '#E90089',
                    negro: '#231F20',
                    gris: '#818486',
                    rosa: '#FFD7F1',
                    fondo: '#F7F6F6',
                    // nombres usados en el tablero original
                    bg: '#FFFFFF',
                    textMain: '#231F20',
                    textAccent: '#E90089',
                },
                pink: {
                    50: '#FFF1FA',
                    100: '#FFD7F1',
                    200: '#FFB3E3',
                    300: '#FF80CF',
                    400: '#F540B3',
                    500: '#E90089',
                    600: '#C70076',
                    700: '#A10060',
                    800: '#7C004A',
                    900: '#590035',
                },
                slate: {
                    50: '#F7F6F6',
                    100: '#EFEEEE',
                    200: '#E3E2E2',
                    300: '#CFCED0',
                    400: '#A6A8AA',
                    500: '#818486',
                    600: '#626466',
                    700: '#474648',
                    800: '#333031',
                    900: '#231F20',
                },
            }
        }
    }
};
