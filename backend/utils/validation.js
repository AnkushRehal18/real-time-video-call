const validator = require("validator");

class validationService {
    static validateSignupData(data) {
        const errors = {}
        const { name, email, password } = data;

        // Name validation 
        if (!name || !name.trim()) {
            errors.name = ["The name field is required."];
        } else if (name.trim().length < 2) {
            errors.name = ["The name must be at least 2 characters."];
        } else if (name.trim().length > 100) {
            errors.name = ["The name must not exceed 100 characters."];
        } else if (!/^[a-zA-Z\s]+$/.test(name.trim())) {
            errors.name = ["The name must contain only letters and spaces."];
        }

        // Email validation
        if (!email || !email.trim()) {
            errors.email = ["The email field is required."];
        } else if (!validator.isEmail(email.trim())) {
            errors.email = ["The email must be a valid email address."];
        } else if (email.trim().length > 255) {
            errors.email = ["The email must not exceed 255 characters."];
        }

        // Password validation
        if (!password) {
            errors.password = ["The password field is required."];
        } else if (!validator.isStrongPassword(password)) {
            errors.password = ["Password must be at least 8 characters and include uppercase, lowercase, numbers, and symbols."];
        }

        if (Object.keys(errors).length > 0) {
            return {
                status: false,
                message: "Validation error.",
                errors
            };
        }

        return null;
    }
    static sanitizeInput(input) {
        if (typeof input === 'string') {
            return validator.escape(input.trim());
        }
        return input;
    }

    static sanitizeObject(obj) {
        const sanitized = {};
        for (const [key, value] of Object.entries(obj)) {
            // Passwords must never be HTML-escaped — the raw string is hashed
            // with bcrypt. Escaping would change the password and the user
            // would not be able to log in with the original value.
            if (key === "password") {
                sanitized[key] = typeof value === "string" ? value.trim() : value;
            } else {
                sanitized[key] = this.sanitizeInput(value);
            }
        }
        return sanitized;
    }
}

module.exports = validationService;