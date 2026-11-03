; benchmark generated from python API
(set-info :status unknown)
(declare-fun g_protected () Bool)
(declare-fun g_old () Int)
(declare-fun g_change () Int)
(declare-fun g_token () Int)
(declare-fun g_effective () Int)
(declare-fun g_accepted () Bool)
(declare-fun g_owner () Int)
(declare-fun g_active () Bool)
(assert
 g_protected)
(assert
 (and (distinct g_change g_old) true))
(assert
 (let (($x91 (= g_effective g_token)))
 (=> g_accepted $x91)))
(assert
 (let (($x91 (= g_effective g_token)))
(let (($x38 (and $x91 (or (not g_active) (= g_owner g_effective)))))
(let (($x35 (and g_protected (and (distinct (ite g_accepted g_change g_old) g_old) true))))
(let (($x60 (=> $x35 $x38)))
(not $x60))))))
(check-sat)
