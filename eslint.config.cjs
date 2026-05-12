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
    // Adapter source directories must wrap timer and event-listener callbacks
    // with this.safeCall() or runInSubsystem() — never register bare callbacks
    // that can silently propagate errors to the process uncaughtException handler.
    {
        files: [
            'src/lights/**/*.js',
            'src/switches/**/*.js',
            'src/radios/zwave/events.js',
            'src/radios/zigbee/events.js',
        ],
        rules: {
            'no-restricted-syntax': [
                'error',
                {
                    selector: 'CallExpression[callee.name="setInterval"]',
                    message: 'Wrap setInterval callbacks with this.safeCall() in adapter files.',
                },
                {
                    selector: 'CallExpression[callee.name="setTimeout"]',
                    message: 'Wrap setTimeout callbacks with this.safeCall() in adapter files.',
                },
            ],
        },
    },
];