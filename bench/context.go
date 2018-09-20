package bench

import (
	"context"
	"io"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pkg/errors"
)

type Context struct {
	logger    *log.Logger
	appep     string
	bankep    string
	logep     string
	bankappid string
	logappid  string
	rand      *Random
	isubank   *Isubank
	idlist    chan string
	closed    chan struct{}
	investors []Investor
	score     int64
	errcount  int64

	nextLock     sync.Mutex
	investorLock sync.Mutex
	level        uint

	lastTradePorring time.Time
}

func NewContext(out io.Writer, appep, bankep, logep, internalbank string) (*Context, error) {
	rand, err := NewRandom()
	if err != nil {
		return nil, err
	}
	isubank, err := NewIsubank(internalbank)
	if err != nil {
		return nil, err
	}
	return &Context{
		logger:    NewLogger(out),
		appep:     appep,
		bankep:    bankep,
		logep:     logep,
		bankappid: rand.ID(),
		logappid:  rand.ID(),
		rand:      rand,
		isubank:   isubank,
		idlist:    make(chan string, 10),
		closed:    make(chan struct{}),
		investors: make([]Investor, 0, 5000),
	}, nil
}

// benchに影響を与えないようにidは予め用意しておく
func (c *Context) RunIDFetcher(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
			id := c.rand.ID()
			if err := c.isubank.NewBankID(id); err != nil {
				log.Printf("new bankid failed. %s", err)
			}
			c.idlist <- id
		}
	}
}

func (c *Context) FetchNewID() string {
	return <-c.idlist
}

func (c *Context) AddInvestor(i Investor) {
	c.investorLock.Lock()
	defer c.investorLock.Unlock()
	c.investors = append(c.investors, i)
}

func (c *Context) RemoveInvestor(i Investor) {
	c.investorLock.Lock()
	defer c.investorLock.Unlock()
	cleared := make([]Investor, 0, cap(c.investors))
	for _, ii := range c.investors {
		if i.BankID() != ii.BankID() {
			cleared = append(cleared, ii)
		}
	}
	c.investors = cleared
}

func (c *Context) AddScore(score int64) {
	atomic.AddInt64(&c.score, score)
}

func (c *Context) GetScore() int64 {
	return atomic.LoadInt64(&c.score)
}

func (c *Context) IncrErr() error {
	ec := atomic.AddInt64(&c.errcount, 1)

	errorLimit := c.GetScore() / 20
	if errorLimit < AllowErrorMin {
		errorLimit = AllowErrorMin
	} else if errorLimit > AllowErrorMax {
		errorLimit = AllowErrorMax
	}
	if errorLimit <= ec {
		return errors.Errorf("エラー件数が規定を超過しました.")
	}
	return nil
}

func (c *Context) ErrorCount() int64 {
	return atomic.LoadInt64(&c.errcount)
}

func (c *Context) TotalScore() int64 {
	score := c.GetScore()
	demerit := score / (AllowErrorMax * 2)

	// エラーが多いと最大スコアが半分になる
	return score - demerit*c.ErrorCount()
}

func (c *Context) AllInvestors() int {
	return len(c.investors)
}

func (c *Context) ActiveInvestors() int {
	var i int
	for _, in := range c.investors {
		if !in.IsRetired() {
			i++
		}
	}
	return i
}

func (c *Context) FindInvestor(bankID string) Investor {
	for _, i := range c.investors {
		if i.BankID() == bankID {
			return i
		}
	}
	return nil
}

func (c *Context) NewClient() (*Client, error) {
	return NewClient(c.appep, c.FetchNewID(), c.rand.Name(), c.rand.Password(), ClientTimeout, RetireTimeout)
}

func (c *Context) Logger() *log.Logger {
	return c.logger
}

func (c *Context) Start() ([]Task, error) {
	c.nextLock.Lock()
	defer c.nextLock.Unlock()

	guest, err := NewClient(c.appep, "", "", "", InitTimeout, InitTimeout)
	if err != nil {
		return nil, err
	}
	if err := guest.Initialize(c.bankep, c.bankappid, c.logep, c.logappid); err != nil {
		return nil, err
	}

	tasks := make([]Task, 0, AddWorkersByLevel)
	for i := 0; i < AddWorkersByLevel; i++ {
		cl, err := c.NewClient()
		if err != nil {
			return nil, err
		}
		var investor Investor
		if i%2 == 1 {
			investor = NewRandomInvestor(cl, 10000, 0, 2, int64(100+i/2))
		} else {
			investor = NewRandomInvestor(cl, 1, 5, 2, int64(100+i/2))
		}
		c.isubank.AddCredit(investor.BankID(), investor.Credit())
		c.AddInvestor(investor)
		tasks = append(tasks, investor.Start())
	}
	return tasks, nil
}

func (c *Context) Next() ([]Task, error) {
	c.nextLock.Lock()
	defer c.nextLock.Unlock()

	tasks := []Task{}
	for _, investor := range c.investors {
		// 初期以外はnextのタイミングで一人づつ投入
		if !investor.IsStarted() {
			tasks = append(tasks, investor.Start())
			break
		}
	}

	for _, investor := range c.investors {
		if !investor.IsSignin() {
			continue
		}
		if task := investor.Next(); task != nil {
			tasks = append(tasks, task)
		}
	}

	score := c.GetScore()
	for {
		// levelup
		nextScore := (1 << c.level) * 100
		if score < int64(nextScore) {
			break
		}
		if AllowErrorMin < c.ErrorCount() {
			// エラー回数がscoreの5%以上あったらワーカーレベルは上がらない
			break
		}
		latestTradePrice := c.investors[0].LatestTradePrice()
		if latestTradePrice == 0 {
			latestTradePrice = 100
		}
		c.level++
		c.Logger().Printf("ワーカーレベルが上がります")

		// 10人追加
		unitamount := int64(c.level * 5)
		for i := 0; i < 10; i++ {
			cl, err := c.NewClient()
			if err != nil {
				return nil, err
			}
			var investor Investor
			if i%2 == 1 {
				investor = NewRandomInvestor(cl, latestTradePrice*1000, 0, unitamount, latestTradePrice-2)
			} else {
				investor = NewRandomInvestor(cl, 1, unitamount*100, unitamount, latestTradePrice+5)
			}
			tasks = append(tasks, NewExecTask(func(_ context.Context) error {
				c.isubank.AddCredit(investor.BankID(), investor.Credit())
				c.AddInvestor(investor)
				return nil
			}, 0))
		}
	}
	return tasks, nil
}
