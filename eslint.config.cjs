module.exports = [
    {
        ignores: [
            'cache/**',
            'coverage/**',
            'node_modules/**',
            'patches/**',
        ],
    },
    {
        files: ['src/**/*.js', 'test/**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
            globals: {
                Buffer: 'readonly',
                URL: 'readonly',
                __dirname: 'readonly',
                __filename: 'readonly',
                clearInterval: 'readonly',
                clearTimeout: 'readonly',
                console: 'readonly',
                global: 'readonly',
                module: 'readonly',
                process: 'readonly',
                require: 'readonly',
                setInterval: 'readonly',
                setTimeout: 'readonly',
            },
        },
        rules: {
            'no-undef': 'error',
            'no-unused-vars': ['error', {
                argsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
            }],
        },
    },
    {
        files: ['test/**/*.js'],
        languageOptions: {
            globals: {
                afterEach: 'readonly',
                beforeEach: 'readonly',
                describe: 'readonly',
                expect: 'readonly',
                it: 'readonly',
                jest: 'readonly',
                setImmediate: 'readonly',
                test: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': 'off',
        },
    },
];