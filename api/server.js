// server.js
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const pdf = require('pdf-parse');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ dest: '/tmp/uploads/' }); // Save files temporarily in /tmp for serverless

app.use(cors());

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, '../public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        const dataBuffer = fs.readFileSync(req.file.path);
        const data = await pdf(dataBuffer);
        const transactions = parseTransactions(data.text);
        const analysis = analyzeTransactions(transactions);
        fs.unlinkSync(req.file.path); // Clean up temporary file
        res.json(analysis);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

function parseTransactions(text) {
    const transactions = [];
    const transactionBlocks = text.split(/\d{2}\/\d{2}\/\d{4}/g).slice(1);
    const dates = text.match(/\d{2}\/\d{2}\/\d{4}/g);
    
    dates.forEach((date, i) => {
        const block = transactionBlocks[i];
        //console.log(block);
        if (!block) return;

        const amountMatch = block.match(/Amount:(\d+,?\d*\.?\d*)/);
        if (!amountMatch) return;

        const amount = parseFloat(amountMatch[1].replace(',', ''));
        
        // Extract service charge if present
        const serviceChargeMatch = block.match(/ServiceCharge:(\d+,?\d*\.?\d*)/);
        const serviceCharge = serviceChargeMatch ? parseFloat(serviceChargeMatch[1].replace(',', '')) : 0;

        // Determine transaction type
        let type = 'Other';
        if(block.includes('SavingsDisbursement') && block.includes('Bill')) type='Kibubu';
        else if ((block.includes('Cash')&& block.includes('In'))||block.includes('Cash In')) type = 'Cash In';
        else if ((block.includes('Cash')&& block.includes('Out'))||block.includes('Cash Out')) type = 'Cash Out';
        else if (block.includes('Send')||block.includes('Send Money')) type = 'Send Money';
        else if (block.includes('Bill Payment')||block.includes('Bill')) type = 'Bill Payment';
        else if (block.includes('Wallet To')||block.includes('Wallet')) type = 'Wallet To Bank';
        else if (block.includes('Bank to') ||block.includes('Bank')) type = 'Bank to Wallet';
        else if (block.includes('MIC Promotion')||block.includes('Promotion')) type = 'Promotion';
        else if (block.includes('Saving Early')||block.includes('Saving')||block.includes('Early')) type = 'Saving Early';
        else if (block.includes('Government Payments')||block.includes('Government')) type = 'Government Payments';
        else if (block.includes('Recieve Money') || block.includes('Recieve')) type = 'Receive Money';

        // Extract TxnID
        const txnIdMatch = block.match(/TxnID:([^,\s]+)/);
        
        transactions.push({
            date,
            amount,
            serviceCharge,
            type,
        });
    });
    //console.log(transactions);
    return transactions;
    
}

function analyzeTransactions(transactions) {
    let mainBalance = 2680;
    let savingsBalance = 0;
    const mainAccount = [];
    const savingsAccount = [];
    
    // Group transactions by date for better context analysis
    const transactionsByDate = transactions.reduce((acc, tx) => {
        const date = tx.date.split('T')[0];
        if (!acc[date]) acc[date] = [];
        acc[date].push(tx);
        return acc;
    }, {});

    // Process transactions by date
    Object.values(transactionsByDate).forEach(dayTransactions => {
        let dailyCredits = 0;
        let dailyDebits = 0;
        
        // First pass: Calculate daily totals excluding Saving Early
        dayTransactions.forEach(tx => {
            if (tx.type !== 'Saving Early') {
                if (['Send Money', 'Bill Payment', 'Wallet To Bank', 'Cash Out', 'Government Payments'].includes(tx.type)) {
                    dailyDebits += tx.amount + (tx.serviceCharge || 0);
                } else {
                    dailyCredits += tx.amount;
                }
            }
        });

        // Process each transaction
        dayTransactions.forEach((currentTx, index) => {
            const nextTx = dayTransactions[index + 1];
            const prevTx = dayTransactions[index - 1];
            
            if (currentTx.type === 'Saving Early') {
                // Primary check: Would this withdrawal make savings negative?
                if (savingsBalance < currentTx.amount) {
                    // Must be a deposit TO savings
                    mainBalance -= currentTx.amount;
                    savingsBalance += currentTx.amount;
                    
                    mainAccount.push({
                        date: currentTx.date,
                        description: 'Transfer to Savings',
                        amount: -currentTx.amount,
                        balance: mainBalance
                    });
                    
                    savingsAccount.push({
                        date: currentTx.date,
                        description: 'Savings Deposit',
                        amount: currentTx.amount,
                        type: 'Transfer In',
                        balance: savingsBalance
                    });
                } else {
                    // We have enough in savings, use context to determine direction
                    const isToSavings = determineTransferDirection({
                        currentTx,
                        nextTx,
                        prevTx,
                        mainBalance,
                        dailyCredits,
                        dailyDebits,
                        remainingTransactions: dayTransactions.slice(index + 1)
                    });

                    if (isToSavings) {
                        mainBalance -= currentTx.amount;
                        savingsBalance += currentTx.amount;
                        
                        mainAccount.push({
                            date: currentTx.date,
                            description: 'Transfer to Savings',
                            amount: -currentTx.amount,
                            balance: mainBalance
                        });
                        
                        savingsAccount.push({
                            date: currentTx.date,
                            description: 'Savings Deposit',
                            amount: currentTx.amount,
                            type: 'Transfer In',
                            balance: savingsBalance
                        });
                    } else {
                        mainBalance += currentTx.amount;
                        savingsBalance -= currentTx.amount;
                        
                        mainAccount.push({
                            date: currentTx.date,
                            description: 'Transfer from Savings',
                            amount: currentTx.amount,
                            balance: mainBalance
                        });
                        
                        savingsAccount.push({
                            date: currentTx.date,
                            description: 'Withdrawal to Main Account',
                            amount: -currentTx.amount,
                            type: 'Transfer Out',
                            balance: savingsBalance
                        });
                    }
                }
            } else {
                // Handle regular transactions
                if (['Send Money', 'Bill Payment', 'Wallet To Bank', 'Cash Out', 'Government Payments'].includes(currentTx.type)) {
                    const totalAmount = currentTx.amount + (currentTx.serviceCharge || 0);
                    mainBalance -= totalAmount;
                    mainAccount.push({
                        ...currentTx,
                        amount: -totalAmount,
                        balance: mainBalance
                    });
                } else {
                    mainBalance += currentTx.amount;
                    mainAccount.push({
                        ...currentTx,
                        balance: mainBalance
                    });
                }
            }
        });
    });
    
    return {
        mainAccount,
        savingsAccount,
        summary: {
            mainBalance,
            savingsBalance,
            totalBalance: mainBalance + savingsBalance,
            transactionCount: transactions.length
        }
    };
}

function determineTransferDirection({
    currentTx,
    nextTx,
    prevTx,
    mainBalance,
    dailyCredits,
    dailyDebits,
    remainingTransactions
}) {
    // Rule 1: Check for immediate following debit transaction
    if (nextTx && ['Cash Out', 'Send Money', 'Bill Payment', 'Wallet To Bank'].includes(nextTx.type)) {
        return false; // Withdrawal from savings
    }

    // Rule 2: Check previous transaction for credit pattern
    if (prevTx && !['Send Money', 'Bill Payment', 'Wallet To Bank', 'Cash Out', 'Government Payments'].includes(prevTx.type)) {
        const potentialMainBalance = mainBalance - currentTx.amount;
        if (potentialMainBalance >= 0) {
            return true; // Likely moving money to savings after receiving funds
        }
    }

    // Rule 3: Check upcoming transactions
    const upcomingDebits = calculateUpcomingDebits(remainingTransactions);
    const balanceAfterTransfer = mainBalance - currentTx.amount;
    
    if (upcomingDebits > 0) {
        if (balanceAfterTransfer < upcomingDebits) {
            return false; // Keep money in main account for upcoming debits
        }
        if (balanceAfterTransfer > upcomingDebits * 1.5) {
            return true; // Enough buffer for upcoming debits, can move to savings
        }
    }

    // Rule 4: Daily pattern analysis
    if (dailyCredits > dailyDebits + currentTx.amount) {
        return true; // More credits than debits, likely moving excess to savings
    }

    // Default behavior
    return mainBalance >= currentTx.amount + calculateUpcomingDebits(remainingTransactions);
}

function calculateUpcomingDebits(transactions) {
    return transactions.reduce((sum, tx) => {
        if (['Send Money', 'Bill Payment', 'Wallet To Bank', 'Cash Out', 'Government Payments'].includes(tx.type)) {
            return sum + tx.amount + (tx.serviceCharge || 0);
        }
        return sum;
    }, 0);
}

module.exports = app; // Export app for serverless deployment

const port = 3000;
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});